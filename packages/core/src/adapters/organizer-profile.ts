import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  DEFAULT_STALE_AFTER_MS, META_FOLDER, MetaEnumRefusedError, createParentFirst, enumerateMetaFolder,
  isMalformed, makeMetaFolderRef, metaReadBudget, parseClaim, withServerClock,
  type MetaEnumCode, type MetaFolderClient,
} from "./organizer-lease.js";
import type { ImapDeadline } from "./imap-bounds.js";
import { readAwayPiles } from "../away-scope.js";
import {
  assertMetaIdentity, readMemo, writeMemo, forgetMemo,
  type MetaIdentity, type Generation,
} from "./meta-memo.js";
import { epochOf, uidRefsAtEpoch } from "../epoch.js";
import {
  MAX_BODY_CONTAINS_CHARS, MAX_SUBJECT_CONTAINS_CHARS, RULE_PRIORITY_MAX, effectForDestination, ruleMatchKey,
  sharedProviderAllowRefusal,
} from "../rule-order.js";
import { DESTINATIONS, canonicalDestination, isConsentingDestination, type Destination } from "../types.js";
import type { KnownSenders, Rule } from "../rules.js";

/**
 * The portable organizer profile — how a mailbox carries its own organizer configuration. The
 * lease answers WHO organizes; this document answers HOW, in the same `ohmail/_meta`. One RFC822
 * message: `X-Ohmail-Profile: 1` discriminates, `X-Ohmail-Install-Id` names the writer, the body
 * is a human preamble plus the JSON document. Public and versioned by `v`: natural keys only,
 * never a row id; a screen-out is a rule to `ohmail/Screened`. Unknown fields are ignored; only a
 * greater `v` is refused, as a typed `newer` result the writer will not overwrite; absence means
 * defaults. Never secrets, never adaptive state. Update = append new, THEN expunge old; readers
 * coalesce by `updatedAt`. Only the active organizer writes.
 *
 * `v` names the CANONICAL FORM as well as the field set, because the fingerprint is taken over
 * the canonical form. v1 is frozen as shipped; v2 orders totally. Both are read for ever, a
 * fingerprint is compared only to one taken at its own version, and a v1 document becomes v2 on
 * its next write.
 */

/**
 * THE FORMAT VERSION THIS BUILD WRITES — and, inseparably, the version of the CANONICAL FORM its
 * fingerprints are taken in. The canonical form is what the fingerprint hashes, so a build that
 * changes the ordering rule has changed every document's identity and must say so in the document.
 * v1 is FROZEN exactly as shipped and is read for ever; v2 is a TOTAL order. A v1 document is
 * re-canonicalised to v2 by its NEXT WRITE, never on read.
 */
export const PROFILE_VERSION = 2;

/** The oldest format version this build reads. Every version from here to {@link PROFILE_VERSION}. */
export const PROFILE_VERSION_MIN_READ = 1;

/**
 * THE LONGEST LIST ONE DOCUMENT CARRIES — the importer's per-list ceiling and the exporter's, so
 * a document this product writes is one it can read back. The import applies all four lists in
 * one transaction, sized otherwise by a server we do not run; the serializer keeps the newest of
 * each, automatic rules going before deliberate ones, rather than publish a document the same
 * product on another machine refuses. Every number sits far above real accounts.
 */
export const PROFILE_LIST_MAX = {
  screener: 20_000,
  rules: 5_000,
  notifyRules: 2_000,
  tagNames: 2_000,
} as const;

/** The canonical forms this build can take a fingerprint in. */
export type ProfileCanonicalVersion = 1 | 2;

/** How many superseded settings messages one tidy pass removes at most, oldest first. */
export const PROFILE_TIDY_MAX_PER_PASS = 100;

/**
 * The discriminator and bookkeeping headers. The lease's `H` table, for the profile.
 *
 * `X-Ohmail-Profile: 1` is the DISCRIMINATOR and never moves with {@link PROFILE_VERSION}: it
 * answers "is this one of ours", which is the same question at every format version. The
 * document's version is `v`, inside the JSON, where a reader that has already decided to parse
 * can act on it.
 */
const H = {
  profile: "X-Ohmail-Profile",
  installId: "X-Ohmail-Install-Id",
  /* The document's `v`, repeated where a header read can see it, so a record from a newer format
     is recognised without its body. Absent means 1 or 2: every build that wrote no such header
     wrote one of those. Every writer after this one MUST carry it. */
  version: "X-Ohmail-Profile-Version",
} as const;

/** The Subject every settings message has carried since v1; the tidy's shape test reads it exactly. */
const PROFILE_SUBJECT_HEADER = "Subject: ohmail settings for this mailbox";

/**
 * DOES THIS MESSAGE CLAIM TO BE A PROFILE AT ALL — the cheap pre-filter the bounded read retains on.
 *
 * Deliberately OVER-inclusive and deliberately not a parser. It answers "could this be one of ours"
 * so that the read's ceilings can be spent on profile records instead of on whatever else shares the
 * folder; {@link parseProfileMessage} remains the only thing that decides what a record MEANS.
 * Retaining a message this says yes to and the parser then rejects costs one slot. Dropping one the
 * parser would have accepted would be a document lost, so the two must not disagree in that
 * direction — hence the header block only, matched case-insensitively, with no other condition.
 */
function looksLikeProfile(raw: string): boolean {
  /* The header block only, and the name anchored at a line start: `Not-X-Ohmail-Profile:` or a
     mention in the body is not a discriminator. The ONE test, {@link PROFILE_HEADER_LINE}, shared
     with the header-only reading and the tidy's shape test, so the three cannot disagree. */
  return discriminatorValues(headerBlockOf(raw)).length > 0;
}

/** A sender this mailbox has screened IN. `address` is the natural key. */
export interface ProfileScreenerEntry {
  address: string;
  /** The display name the user gave the contact, if any. */
  name?: string;
  /**
   * WHO MADE THE CONTACT (mail 0147): `person` for a person's own decision. ABSENT is inferred — a
   * reply or the act's admission, or a document written before the key — so an older document
   * fails closed for the identity fact while its senders still pass the gate. The canonical form
   * keeps `person` and drops `inferred`, so a document without the key keeps its fingerprint.
   */
  source?: "person" | "inferred";
}

/** One filing rule, by natural keys — the folder NAME, never a folder id. */
export interface ProfileRuleEntry {
  kind: string;
  match: string;
  destination: string;
  priority: number;
  enabled: boolean;
  provenance: string;
  subjectContains?: string;
  bodyContains?: string;
  /**
   * WHEN A PERSON DECIDED THIS RULE — `rules.person_decided_at`, an ISO 8601 instant, OPTIONAL and
   * present only when stamped, so a document written before the key keeps its fingerprint. It is
   * what keeps another organizer's learning off a sender the person decided: a merge writes a stamp
   * it receives and never clears one it holds. `PROFILE_VERSION` does not move (field-level both ways).
   */
  personDecidedAt?: string;
}

/** One notification opt-in. */
export interface ProfileNotifyRuleEntry {
  kind: string;
  target: string;
}

/**
 * The single per-mailbox autoresponder. Timestamps are ISO 8601 strings or null. `subject` is
 * GONE (mail 0087): the responder is reply-only and derives `Re: <what they wrote>`; an older
 * document still carries the field and the parser does not read it — an unknown key is not an
 * error, which makes the removal safe in both directions. `throttle` is new and defaults to
 * `'per_day'` for a document predating it, the rate every migrated row carries. `PROFILE_VERSION`
 * did NOT move for either: the version is about what a reader must understand to apply a document
 * safely, and both changes are field-level compatible in both directions — bumping would have made
 * older installs refuse a document they read perfectly well. (It moved to 2 later, for the
 * canonical ORDER, which is not a fact about the field set.)
 */
export interface ProfileAwayResponder {
  enabled: boolean;
  body: string | null;
  startsAt: string | null;
  endsAt: string | null;
  audience: string;
  throttle: string;
  /**
   * WHICH PILES THE RESPONDER ANSWERS (mail 0096) — and OPTIONAL, which is the whole of its
   * compatibility rule.
   *
   * A document written before this field existed is not saying "answer the Ohbox"; it is saying
   * nothing about scope. Absent therefore means UNSTATED and the reader leaves what it has stored
   * alone, where a default would silently narrow every adoption from an older install. An explicit
   * empty list is a real answer — "answer nobody" — and is kept.
   */
  piles?: string[];
}

/** The configuration itself — everything that travels, and nothing else. */
export interface OrganizerProfilePayload {
  screener: ProfileScreenerEntry[];
  rules: ProfileRuleEntry[];
  notifyRules: ProfileNotifyRuleEntry[];
  awayResponder: ProfileAwayResponder | null;
  tagNames: string[];
  /**
   * The mailbox's signature (mail 0094) — `mailboxes.signature`, the text appended to outgoing
   * mail from this address. It travels for the away-responder body's reason: per-mailbox
   * configuration the ORGANIZER applies, so a read-only install must see what it currently is.
   * `null` is no signature, and ABSENT parses to `null` too — deliberately not distinguished,
   * unlike `throttle`, because a signature has no third state and "unknown" would buy nothing.
   * `PROFILE_VERSION` did not move for this, on mail 0087's argument: field-level compatible in
   * both directions, and a bump would have made older installs refuse a document they can read.
   */
  signature: string | null;
  /**
   * THE SIGNATURE'S MARKUP — `mailboxes.signature_html`, OPTIONAL, and that is the whole of its
   * compatibility rule. Absent and `null` are ONE state, "no formatting in this signature", which
   * is not the same as having no signature ({@link signature} answers that). The canonical form
   * OMITS the key rather than serializing `null` the way the frozen `signature` field does, so a
   * document written before this key keeps its fingerprint — `piles`' rule, for `piles`' reason.
   * Markup with no text beside it is not representable: `withSignature` puts the TEXT on the
   * plain body in both branches, so markup alone would send a formatted sign-off to everyone but
   * a plaintext reader. `PROFILE_VERSION` does not move — field-level compatible both ways.
   */
  signatureHtml?: string | null;
}

/** The payload wrapped in its versioned envelope — the document as written. */
export interface OrganizerProfileDoc extends OrganizerProfilePayload {
  v: number;
  updatedAt: string;
  producer: {
    kind: string;
    version: string;
    /**
     * THE PRODUCER STATES THAT ITS RULES CARRY EVERY STAMP: `true` from each build whose store ran
     * mail 0146 and whose import stamps on arrival, absent from every older one. It describes the
     * write, so it stays out of the fingerprint. An older copy cannot carry a stamp its producer
     * never wrote, so its import reads the copy's own Screener instead ({@link arrivesDecided}).
     */
    stamped?: true;
  };
}

/** A payload with nothing in it — what a mailbox with no configuration serializes to. */
export function isEmptyProfilePayload(p: OrganizerProfilePayload): boolean {
  return p.screener.length === 0 && p.rules.length === 0 && p.notifyRules.length === 0
    && p.awayResponder === null && p.tagNames.length === 0
    /* `?? null` for `canonicalizeProfilePayload`'s reason: a payload assembled in memory without
       this key carries `undefined`, one parsed from a document carries `null`, and both mean "no
       signature". Comparing to `null` alone would call the first one non-empty — so a mailbox with
       nothing configured would publish a document instead of staying silent. */
    && (p.signature ?? null) === null
    /* Not a separate arm in practice — the canonical form drops markup with no text beside it, so
       a payload whose only content is `signatureHtml` is empty once canonicalised. Stated anyway,
       because this predicate runs on the RAW payload and "publish nothing" must be decided on
       what the payload says rather than on what the canonicaliser would make of it. */
    && (p.signatureHtml ?? null) === null;
}

/** One document rule as the import writes it: the entry, validated and normalized. */
export interface ApplicableProfileRule {
  kind: string;
  match: string;
  destination: string;
  priority: number;
  enabled: boolean;
  provenance: string;
  subjectContains: string | null;
  bodyContains: string | null;
  /** The person's stamp the document carries; `null` when it carries none or an unreadable one. */
  personDecidedAt: Date | null;
}

const PROFILE_RULE_KINDS = new Set(["sender", "domain", "header"]);
const PROFILE_RULE_FOLDERS = new Set<string>(DESTINATIONS);

/** PostgreSQL text cannot hold a NUL: a document string carrying one is skipped, never stored. */
const hasNul = (v: string): boolean => v.includes("\u0000");

/**
 * A term normalized as `RulesService` normalizes one, or `invalid` where the service would 400.
 * An invalid term invalidates its RULE: coercing it to none would widen the rule to the sender's
 * whole mail, the exact misreading the service refuses.
 */
function profileRuleTerm(v: string | undefined, max: number): string | null | "invalid" {
  if (v === undefined || v === null) return null;
  const term = v.trim();
  if (term.length === 0 || term.length > max || hasNul(term)) return "invalid";
  return term;
}

/**
 * THE ONE CONVERTER: a document rule admitted under the product's own create rules, or `null` (the
 * import skips and counts it). The import writes what this returns and the import hold asks the
 * gate about the same rules through {@link profileGateView}, so a rule the import would skip
 * decides nothing about held mail.
 */
export function applicableProfileRule(r: ProfileRuleEntry): ApplicableProfileRule | null {
  if (!PROFILE_RULE_KINDS.has(r.kind)) return null;
  if (typeof r.match !== "string" || r.match.length === 0 || hasNul(r.match)) return null;
  if (!PROFILE_RULE_FOLDERS.has(r.destination)) return null;
  // Everyone at a shared provider let through is no rule here either: it would admit nobody.
  if (sharedProviderAllowRefusal({ kind: r.kind, match: r.match, destination: r.destination }) !== null) return null;
  if (!Number.isInteger(r.priority) || r.priority < 0 || r.priority > RULE_PRIORITY_MAX) return null;
  const subjectContains = profileRuleTerm(r.subjectContains, MAX_SUBJECT_CONTAINS_CHARS);
  const bodyContains = profileRuleTerm(r.bodyContains, MAX_BODY_CONTAINS_CHARS);
  if (subjectContains === "invalid" || bodyContains === "invalid") return null;
  if ((subjectContains !== null || bodyContains !== null) && r.kind !== "sender") return null;
  const provenance = typeof r.provenance === "string" && r.provenance.length > 0 ? r.provenance : "manual";
  if (hasNul(provenance)) return null;
  // A stamp that is not an instant is not a decision anybody can be held to: absent, not refused.
  const stamp = typeof r.personDecidedAt === "string" ? new Date(r.personDecidedAt) : null;
  return {
    kind: r.kind, match: r.match, destination: r.destination, priority: r.priority,
    enabled: r.enabled === true, provenance, subjectContains, bodyContains,
    personDecidedAt: stamp !== null && Number.isFinite(stamp.getTime()) ? stamp : null,
  };
}

/**
 * DOES THIS RULE ARRIVE AS THE PERSON'S — the import's stamp for a copy whose producer did not state
 * `producer.stamped`. Such a copy carries no stamp for a decision made before stamps travelled, so a
 * promoted, unstamped, bare sender rule admitting the sender to the Inbox, News or Receipts is the
 * person's when the copy's own Screener lists the address: "Not junk, always allow" and a Screener
 * yes write that contact, a learned promotion never does. Never a screen-out: that stamp also
 * licenses unsubscribing.
 */
export function arrivesDecided(
  want: ApplicableProfileRule, o: { stamped: boolean; admitted: { has(address: string): boolean } },
): boolean {
  return !o.stamped && want.kind === "sender" && want.provenance === "promoted"
    && want.personDecidedAt === null && want.subjectContains === null && want.bodyContains === null
    && isConsentingDestination(want.destination)
    && o.admitted.has(ruleMatchKey(want.match));
}

/** A screener entry's address as the import writes it into `contacts`, or `null` (skipped). */
export function profileScreenerAddress(s: ProfileScreenerEntry): string | null {
  const address = s.address.trim().toLowerCase();
  return address.length === 0 || hasNul(address) ? null : address;
}

/** The first list over its {@link PROFILE_LIST_MAX} ceiling, or `null`. The import refuses such a document whole. */
export function oversizedProfileList(
  doc: OrganizerProfilePayload,
): { list: string; count: number; max: number } | null {
  for (const key of ["screener", "rules", "notifyRules", "tagNames"] as const) {
    const n = doc[key].length;
    const max = PROFILE_LIST_MAX[key];
    if (n > max) return { list: key, count: n, max };
  }
  return null;
}

/**
 * What the gate reads of a document: the `contacts` and `rules` an import would write. An entry's
 * `source` decides which: a person's contact, or an inferred one (absent included), which admits
 * ordinary mail and never a name claiming a company.
 */
export interface ProfileGateView {
  knownSenders: KnownSenders;
  rules: readonly Rule[];
}

/**
 * THE DOCUMENT'S OPINION AT THE CONSENT GATE, in the shapes `evaluateRules` reads — through the
 * import's own converters, so the routing hold (`PlanDeps.importHold`) covers exactly the mail an
 * import would let through. The destination is canonicalized and its effect derived as
 * `listRules` does; the ids are positional and never stored.
 */
export function profileGateView(doc: OrganizerProfilePayload): ProfileGateView {
  const addresses = new Set<string>();
  // The last entry for an address wins, as the import writes it.
  const person = new Map<string, boolean>();
  for (const s of doc.screener) {
    const address = profileScreenerAddress(s);
    if (address === null) continue;
    addresses.add(address);
    person.set(address, s.source === "person");
  }
  const inferred = new Set([...person].filter(([, p]) => !p).map(([a]) => a));
  const rules: Rule[] = [];
  doc.rules.forEach((entry, i) => {
    const a = applicableProfileRule(entry);
    if (a === null) return;
    const destination = canonicalDestination(a.destination) as Destination;
    rules.push({
      id: `profile-rule-${String(i).padStart(6, "0")}`, kind: a.kind as Rule["kind"], match: a.match,
      destination, effect: effectForDestination(destination), priority: a.priority,
      provenance: a.provenance as Rule["provenance"], enabled: a.enabled,
      subjectContains: a.subjectContains, bodyContains: a.bodyContains,
    });
  });
  return { knownSenders: { addresses, inferred }, rules };
}

/**
 * ONE CANONICAL ORDER PER VERSION, so equality is content equality.
 *
 * The dirty check that drives write-behind is a fingerprint comparison, and a fingerprint over an
 * unordered serialization would report "changed" whenever a database happened to return rows in a
 * different order — which is a rewrite of the document per poll interval on some drivers. Sorting
 * by the natural keys makes the fingerprint a function of the configuration and of nothing else.
 *
 * v1's comparators sort on the natural keys and stop, so two entries agreeing on those and
 * differing elsewhere compare EQUAL and a stable sort leaves them in ARRIVAL order: measured, six
 * permutations of one three-entry screener produced six different fingerprints. That fingerprint
 * is compared across installs, so two installs holding identical configuration in a different
 * order each read the other's document as a stranger's.
 *
 * The order could not simply be made total: the canonical form is what the fingerprint is taken
 * over, so every already-written tied document would re-fingerprint and an install would read its
 * own week-old document as foreign. Hence a VERSION. v1 stays exactly as shipped and keeps its
 * documents' identities; v2 is total; the reader accepts both for ever, a fingerprint is only
 * ever compared to another taken at the SAME version, and a v1 document becomes v2 on its next
 * write — never on read.
 */
/**
 * Order two strings the same way on every machine. `localeCompare` is locale-dependent, and these
 * orderings feed {@link canonicalizeProfilePayload}, whose output {@link profileFingerprint}
 * hashes and compares ACROSS INSTALLS — different ICU, different fingerprint, every takeover
 * refused for ever. UTF-16 CODE UNIT order — defined by the language, not ICU.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ONE STRING PER VALUE — v2's serialization, and the tie-break's key.
 *
 * Object keys in code-unit order rather than whichever order a literal in this file happens to
 * declare them in, so the canonical form is a function of the CONTENT alone: re-ordering one of
 * the object literals below must not re-fingerprint every document in every mailbox. `-0`
 * normalises to `0`, stated rather than inherited from `JSON.stringify`. A non-finite number
 * cannot arrive — the parser refuses one — and an `undefined` value is a key that is not there.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "number") return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(byCodeUnit);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Sort by `cmp`, then by the entry's OWN canonical JSON — which is what makes the order total.
 *
 * Two entries surviving the tie-break have identical canonical bytes, so no ordering of them is
 * distinguishable in the canonical form and the sort's stability stops being load-bearing.
 */
function totalSort<T>(xs: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return [...xs].sort((a, b) => cmp(a, b) || byCodeUnit(canonicalJson(a), canonicalJson(b)));
}

/* The normalised entry shapes — shared by both versions, which differ ONLY in the sort. */
const emptyIfAbsent = (v: string | undefined | null): string => v ?? "";

function normalizeScreener(s: ProfileScreenerEntry): ProfileScreenerEntry {
  return {
    address: s.address,
    ...(s.name === undefined || s.name === null ? {} : { name: s.name }),
    // Present only for a person's contact: inferred and absent are one state, and v1 keeps its bytes.
    ...(s.source === "person" ? { source: "person" as const } : {}),
  };
}

function normalizeRule(r: ProfileRuleEntry): ProfileRuleEntry {
  return {
    kind: r.kind, match: r.match, destination: r.destination,
    priority: r.priority, enabled: r.enabled, provenance: r.provenance,
    ...(r.subjectContains === undefined || r.subjectContains === null ? {} : { subjectContains: r.subjectContains }),
    ...(r.bodyContains === undefined || r.bodyContains === null ? {} : { bodyContains: r.bodyContains }),
    // Present only when stamped: an unstamped rule keeps the bytes it had before the key existed.
    ...(r.personDecidedAt === undefined || r.personDecidedAt === null ? {} : { personDecidedAt: r.personDecidedAt }),
  };
}

function cmpScreener(a: ProfileScreenerEntry, b: ProfileScreenerEntry): number {
  return byCodeUnit(a.address, b.address);
}

function cmpRule(a: ProfileRuleEntry, b: ProfileRuleEntry): number {
  return byCodeUnit(a.kind, b.kind)
    || byCodeUnit(a.match, b.match)
    || byCodeUnit(emptyIfAbsent(a.subjectContains), emptyIfAbsent(b.subjectContains))
    || byCodeUnit(emptyIfAbsent(a.bodyContains), emptyIfAbsent(b.bodyContains))
    || byCodeUnit(a.destination, b.destination)
    || a.priority - b.priority
    || byCodeUnit(a.provenance, b.provenance)
    || Number(a.enabled) - Number(b.enabled);
}

function cmpNotify(a: ProfileNotifyRuleEntry, b: ProfileNotifyRuleEntry): number {
  return byCodeUnit(a.kind, b.kind) || byCodeUnit(a.target, b.target);
}

/**
 * The away section, identical at both versions: `piles` is already a deduped sorted SET and every
 * other field is scalar, so there is no order here for a tie-break to decide.
 */
function normalizeAway(a: ProfileAwayResponder | null): ProfileAwayResponder | null {
  if (a === null) return null;
  return {
    enabled: a.enabled,
    body: a.body,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    audience: a.audience,
    throttle: a.throttle,
    /* SORTED, because the value is a SET and the endpoint does not preserve order — two
       payloads meaning the same scope must not hash differently. ABSENT WHEN ABSENT, for the
       reason the signature field spells out one key below: adding a key here for a document
       that never had one would change the fingerprint of every profile an older ohmail wrote. */
    /* `Array.isArray` AND NOT A TRUTHINESS TEST. `[...new Set("ohmail/Reads")]` spreads a STRING
       into its characters, so a malformed in-memory payload would be canonicalised into a
       plausible-looking array of single letters and published as one. A non-array is dropped
       here, which leaves the parser to refuse the document it arrives in. */
    ...(Array.isArray(a.piles) ? { piles: [...new Set(a.piles)].sort(byCodeUnit) } : {}),
  };
}

/**
 * FORMAT v1 — FROZEN. Not a style to keep tidy: every profile message an ohmail up to 0.17 wrote
 * into somebody's mailbox has its identity in these bytes, and every stored import resolution and
 * detection marker holds a hash of them. Changing anything here re-fingerprints those documents
 * and re-asks questions their owners already answered. New rules go in a new version.
 */
function canonicalizeV1(p: OrganizerProfilePayload): OrganizerProfilePayload {
  return {
    screener: [...p.screener].map(normalizeScreener).sort(cmpScreener),
    rules: [...p.rules].map(normalizeRule).sort(cmpRule),
    notifyRules: [...p.notifyRules].map((n) => ({ kind: n.kind, target: n.target })).sort(cmpNotify),
    awayResponder: normalizeAway(p.awayResponder),
    tagNames: [...p.tagNames].sort(byCodeUnit),
    /* `?? null` RATHER THAN A PASS-THROUGH, and it is the fingerprint that needs it. An in-memory
       payload assembled without this key has `undefined` here; `JSON.stringify` drops an undefined
       value entirely, while a payload PARSED from a document carries an explicit `null` and
       serializes `"signature":null`. Two payloads meaning the same thing would then hash
       differently — and the fingerprint is what decides "is the held document already what I
       have", so the disagreement shows up as an import prompt that cannot be made to go away.
       Normalised here, in the one function every fingerprint goes through. */
    signature: p.signature ?? null,
    ...signatureHtmlOf(p),
  };
}

/**
 * FORMAT v2 — the same rules with a TOTAL order: every array sorted by its stated comparator and
 * then by the entry's own canonical JSON, which no two distinguishable entries can tie on. The
 * FIELDS are v1's, unchanged in name and meaning; only the ordering rule and the serialization
 * moved, which is the whole of what a canonical-form version is allowed to be.
 */
function canonicalizeV2(p: OrganizerProfilePayload): OrganizerProfilePayload {
  return {
    screener: totalSort(p.screener.map(normalizeScreener), cmpScreener),
    rules: totalSort(p.rules.map(normalizeRule), cmpRule),
    notifyRules: totalSort(p.notifyRules.map((n) => ({ kind: n.kind, target: n.target })), cmpNotify),
    awayResponder: normalizeAway(p.awayResponder),
    // Strings are their own canonical form, so code-unit order is already total over them.
    tagNames: [...p.tagNames].sort(byCodeUnit),
    signature: p.signature ?? null,
    ...signatureHtmlOf(p),
  };
}

/**
 * THE MARKUP KEY, PRESENT ONLY WHEN IT SAYS SOMETHING — the spread that keeps every document an
 * older ohmail wrote at the fingerprint it was written with. `signature`, one key up, is emitted
 * as `?? null` because it has been in the frozen form since mail 0094; this key is NEW, so
 * emitting `null` for a document that never had it would re-fingerprint the lot. Two collapses,
 * both deliberate: markup blank after trimming is no markup (an empty `<p></p>` is a tag, not a
 * sign-off), and markup with NO TEXT beside it is dropped, because the text half is what a
 * plaintext recipient reads and a document offering only the formatted form describes a message
 * nobody can send.
 */
function signatureHtmlOf(p: OrganizerProfilePayload): { signatureHtml?: string } {
  const text = p.signature ?? null;
  const html = p.signatureHtml ?? null;
  if (text === null || html === null || html.trim().length === 0) return {};
  return { signatureHtml: html };
}

/**
 * The canonical form at `version` — v1 as shipped, v2 total. An unsupported version THROWS rather
 * than falling back: silently canonicalising an unknown format at this build's rules would mint a
 * confident fingerprint for a document nobody here can read. Unreachable through the parser, which
 * refuses a greater `v` as `newer` before a payload is ever built.
 */
export function canonicalizeProfilePayload(
  p: OrganizerProfilePayload,
  version: number = PROFILE_VERSION,
): OrganizerProfilePayload {
  if (version === 1) return canonicalizeV1(p);
  if (version === 2) return canonicalizeV2(p);
  throw new RangeError(`no canonical form for profile version ${version}`);
}

/** Which canonical form a payload's fingerprint is taken in when the caller does not say. */
function canonicalVersionOf(p: { v?: number }): number {
  return p.v === 1 || p.v === 2 ? p.v : PROFILE_VERSION;
}

/**
 * The content identity of a payload — sha256 over the canonical serialization, TAGGED with the
 * version it was taken in.
 *
 * `updatedAt` and `producer` are deliberately NOT part of it: they describe the WRITE, not the
 * configuration, and folding them in would make every copy of identical configuration look
 * different — which defeats both the dirty check and the "this found document is what I already
 * have" comparison the read-on-takeover path makes.
 *
 * THE VERSION IS THE DOCUMENT'S when it has one, and this build's otherwise: a document parsed
 * out of a mailbox keeps the identity it was written with, so a resolution or marker an older
 * ohmail stored still matches it. v1 stays a BARE hex, which is what every stored row already
 * holds; v2 and later carry a `"<v>:"` prefix, so two fingerprints from different versions can
 * never compare equal by accident. {@link compareProfileFingerprints} names that third outcome.
 *
 * Comparing a LOCAL payload to a found document is a question about content, so it is asked at
 * ONE version — pass the document's — never by hashing each at its own.
 */
export function profileFingerprint(
  p: OrganizerProfilePayload & { v?: number },
  version: number = canonicalVersionOf(p),
): string {
  const canonical = canonicalizeProfilePayload(p, version);
  const bytes = version === 1 ? JSON.stringify(canonical) : canonicalJson(canonical);
  const hash = createHash("sha256").update(bytes, "utf8").digest("hex");
  return version === 1 ? hash : `${version}:${hash}`;
}

/** Which canonical form a fingerprint was taken in. An untagged one is v1, by construction. */
export function profileFingerprintVersion(fingerprint: string): number {
  const at = fingerprint.indexOf(":");
  if (at <= 0) return 1;
  const v = Number(fingerprint.slice(0, at));
  return Number.isSafeInteger(v) && v >= 1 ? v : 1;
}

/**
 * DOES THE LOCAL STORE SAY WHAT A DOCUMENT WITH THIS FINGERPRINT SAYS — at the document's canonical
 * version, and once more with the local screener's `source` left out (mail 0147): a document that
 * states no source, which every older one is, names the same contacts, and an import changes the
 * source of no contact this install holds, so the key's arrival is never a question by itself.
 */
export function localSaysWhatAFingerprintSays(local: OrganizerProfilePayload, fingerprint: string): boolean {
  const v = profileFingerprintVersion(fingerprint);
  if (profileFingerprint(local, v) === fingerprint) return true;
  const unstated = { ...local, screener: local.screener.map(({ address, name }) => (name === undefined ? { address } : { address, name })) };
  return profileFingerprint(unstated, v) === fingerprint;
}

/**
 * `different-version` IS NOT `different`, and the distinction is the whole point of versioning the
 * form: two fingerprints taken at different versions say NOTHING about whether the configurations
 * agree, so the answer is a re-canonicalise signal — write it out again at this build's version —
 * and never a conflict to surface to somebody.
 */
export function compareProfileFingerprints(a: string, b: string): "same" | "different" | "different-version" {
  if (a === b) return "same";
  return profileFingerprintVersion(a) === profileFingerprintVersion(b) ? "different" : "different-version";
}

/**
 * The envelope, assembled in the spec's key order over a canonicalized payload.
 *
 * THE STAMPED `v` AND THE FORM THE PAYLOAD WAS CANONICALISED IN ARE ONE VALUE. They were two
 * literals a line apart, and a document stamped v2 whose arrays were ordered by v1's rules would
 * be a lie no reader could detect — it parses, it fingerprints, and it fingerprints WRONG on
 * every other install. `version` exists so an older document can be rebuilt exactly as its
 * writer wrote it; it defaults to what this build writes.
 */
export function makeProfileDoc(
  payload: OrganizerProfilePayload,
  meta: { updatedAt: Date; producer: { kind: string; version: string } },
  version: number = PROFILE_VERSION,
): OrganizerProfileDoc {
  const canonical = canonicalizeProfilePayload(payload, version);
  return {
    v: version,
    updatedAt: meta.updatedAt.toISOString(),
    // Every copy this build writes is one whose rules carry their stamps — see `producer.stamped`.
    producer: { kind: meta.producer.kind, version: meta.producer.version, stamped: true },
    screener: canonical.screener,
    rules: canonical.rules,
    notifyRules: canonical.notifyRules,
    awayResponder: canonical.awayResponder,
    tagNames: canonical.tagNames,
    signature: canonical.signature,
    /* SPREAD, not a `?? null` assignment: the canonical form decides whether this key exists at
       all, and re-stating it here as an explicit `null` would put back exactly the byte that
       re-fingerprints every document written before the field. This line is the envelope
       carrying what the canonicaliser answered, and nothing else. */
    ...(canonical.signatureHtml === undefined ? {} : { signatureHtml: canonical.signatureHtml }),
  };
}

/** Strip CR/LF so no value can inject a header. The lease's `headerSafe`, unchanged. */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

/**
 * THE PREAMBLE — for the person who finds this message in Apple Mail and wonders what it is.
 *
 * It is written for a stranger: what the message is, that deleting it is safe and what deleting
 * it does, and that the format below is documented. It must contain no `{` — the JSON extractor
 * takes the body's first `{` as the document's start, and the suite pins that property.
 */
const PREAMBLE = [
  "This message stores your ohmail settings for this mailbox: which senders",
  "you have screened in, your filing rules, notification choices, away reply",
  "and tag names. Keeping them here means they live in YOUR mailbox: they",
  "travel with it to any computer or service you connect it from, and they",
  "remain yours even if you stop using ohmail.",
  "",
  "Names and addresses below are written as JSON escapes; any JSON tool",
  "shows them as text.",
  "",
  "Deleting this message is safe. It only resets ohmail's settings for this",
  "mailbox; your mail is not touched. ohmail writes a fresh copy when its",
  "settings next change.",
  "",
  "The format: versioned JSON, documented in ohmail's published source",
  "(packages/core/src/adapters/organizer-profile.ts).",
] as const;

/**
 * THE STRING VALUES WRITTEN AS THEY ARE: format fields and enums, never a person's words. Every
 * other string VALUE is written as `\uXXXX`, one escape per UTF-16 code unit, so a mail client's
 * search index finds no name, address or rule text in this message. The list is closed, so a new
 * field is escaped until someone adds it here. Keys, numbers and booleans are plain.
 */
const PLAIN_STRING_VALUES: ReadonlySet<string> = new Set([
  "updatedAt", "producer.kind", "producer.version", "screener[].source", "rules[].kind", "rules[].provenance", "rules[].personDecidedAt",
  "notifyRules[].kind", "awayResponder.audience", "awayResponder.throttle",
  "awayResponder.startsAt", "awayResponder.endsAt", "awayResponder.piles[]",
]);

const hex4 = (unit: number): string => `\\u${unit.toString(16).padStart(4, "0")}`;

/** A JSON string literal: plain ASCII where the path allows it, `\uXXXX` for every code unit otherwise. */
function stringLiteral(value: string, plain: boolean): string {
  if (!plain) {
    let out = "\"";
    for (let i = 0; i < value.length; i++) out += hex4(value.charCodeAt(i));
    return `${out}"`;
  }
  // JSON.stringify's own escapes, then anything outside printable ASCII as \uXXXX.
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (ch) => hex4(ch.charCodeAt(0)));
}

/** `JSON.stringify(value, null, 2)`'s layout and key order, with string values spelled as above. */
function serializeValue(value: unknown, path: string, indent: string): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return stringLiteral(value, PLAIN_STRING_VALUES.has(path));
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = `${indent}  `;
    const items = value.map((v) => `${inner}${serializeValue(v, `${path}[]`, inner) ?? "null"}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object") {
    const inner = `${indent}  `;
    const entries: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = serializeValue(v, path === "" ? k : `${path}.${k}`, inner);
      if (s !== undefined) entries.push(`${inner}${JSON.stringify(k)}: ${s}`);
    }
    return entries.length === 0 ? "{}" : `{\n${entries.join(",\n")}\n${indent}}`;
  }
  return undefined;
}

/**
 * THE DOCUMENT AS THE MESSAGE CARRIES IT: pure ASCII, and every shipped reader (`JSON.parse` of the
 * body from its first `{` to its last `}`) decodes it to the same values, so no fingerprint moves
 * and `v` stays as it is. Asserted, not assumed: a serialization that parses to anything else
 * throws before the message is appended.
 */
export function serializeProfileDoc(doc: OrganizerProfileDoc): string {
  const out = serializeValue(doc, "", "")!;
  if (!isDeepStrictEqual(JSON.parse(out), JSON.parse(JSON.stringify(doc)))) {
    throw new Error("the settings document did not serialize to itself");
  }
  return out;
}

/**
 * One RFC822 message per profile.
 *
 * The JSON keeps its two-space layout, with every person's value written as JSON escapes by
 * {@link serializeProfileDoc}, so the whole message is 7-bit ASCII and a search finds none of it.
 */
export function formatProfileMessage(doc: OrganizerProfileDoc, opts: { installId: string }): string {
  const lines = [
    `${H.profile}: 1`,
    `${H.installId}: ${headerSafe(opts.installId)}`,
    `${H.version}: ${doc.v}`,
    PROFILE_SUBJECT_HEADER,
    `Date: ${new Date(doc.updatedAt).toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    "",
    ...PREAMBLE,
    "",
    // CRLF inside the document too: a bare LF is not RFC 5322, and Dovecot rewrites it on storage.
    serializeProfileDoc(doc).replace(/\n/g, "\r\n"),
    "",
  ];
  return lines.join("\r\n");
}

/**
 * A message that says it is a profile and then cannot be read as one.
 *
 * Distinct from "not a profile" for the lease's reason restated: a message WITHOUT
 * `X-Ohmail-Profile: 1` is a claim, a stray or a future meta record type and is invisible here;
 * a message WITH it whose document is unreadable is a corrupt copy of OUR OWN bookkeeping — it
 * carries nothing recoverable, so unlike a malformed lease claim it may be replaced by the next
 * write, but it is still reported rather than silently treated as absent.
 */
export interface MalformedProfile {
  malformed: true;
  reason: string;
  ref?: unknown;
}

/** A parsed profile message: the document, plus the transport facts around it. */
export interface ParsedProfileMessage {
  /** `ok` — readable at this version. `newer` — a later format; leave it alone. */
  status: "ok" | "newer";
  /** Present when `status` is `"ok"`. */
  doc?: OrganizerProfileDoc;
  /** The document's `v`, whatever it was. */
  v: number;
  /** `X-Ohmail-Install-Id` — which organizer wrote this copy, or null if absent. */
  installId: string | null;
  ref?: unknown;
  /**
   * The body's document is exactly what {@link serializeProfileDoc} writes for it (CRLF read as
   * LF). `false` for a message written before the escapes: its names are still plain text, and
   * the holder rewrites it once. Absent on a `newer` document.
   */
  encoded?: boolean;
}

export type ProfileRecord = ParsedProfileMessage | MalformedProfile;

export function isMalformedProfile(r: ProfileRecord): r is MalformedProfile {
  return (r as MalformedProfile).malformed === true;
}

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Exactly what `Date.prototype.toISOString` writes — the one form `makeProfileDoc` stamps. */
function isWrittenInstant(s: string): boolean {
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s;
}

/** The tolerant reader of one section entry. Drops entries missing their natural key. */
function readPayload(raw: Record<string, unknown>): OrganizerProfilePayload {
  const screener: ProfileScreenerEntry[] = [];
  if (Array.isArray(raw.screener)) {
    for (const e of raw.screener) {
      if (typeof e !== "object" || e === null) continue;
      const address = asString((e as Record<string, unknown>).address)?.trim();
      if (!address) continue;
      const name = asString((e as Record<string, unknown>).name);
      // Only a person's contact is stated; anything else, absent included, reads as inferred.
      const person = (e as Record<string, unknown>).source === "person";
      screener.push({ address, ...(name === null ? {} : { name }), ...(person ? { source: "person" as const } : {}) });
    }
  }
  const rules: ProfileRuleEntry[] = [];
  if (Array.isArray(raw.rules)) {
    for (const e of raw.rules) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      const kind = asString(o.kind);
      const match = asString(o.match);
      const destination = asString(o.destination);
      if (!kind || !match || !destination) continue;
      const subjectContains = asString(o.subjectContains);
      const bodyContains = asString(o.bodyContains);
      // Only the instant `toISOString` writes; anything else reads as no stamp.
      const personDecidedAt = asString(o.personDecidedAt);
      rules.push({
        kind, match, destination,
        // Clamped into the one bound, so an imported rule is one every other door accepts.
        priority: typeof o.priority === "number" && Number.isFinite(o.priority)
          ? Math.min(Math.max(Math.round(o.priority), 0), RULE_PRIORITY_MAX) : 0,
        enabled: typeof o.enabled === "boolean" ? o.enabled : true,
        provenance: asString(o.provenance) ?? "manual",
        ...(subjectContains === null ? {} : { subjectContains }),
        ...(bodyContains === null ? {} : { bodyContains }),
        ...(personDecidedAt !== null && isWrittenInstant(personDecidedAt) ? { personDecidedAt } : {}),
      });
    }
  }
  const notifyRules: ProfileNotifyRuleEntry[] = [];
  if (Array.isArray(raw.notifyRules)) {
    for (const e of raw.notifyRules) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      const target = asString(o.target);
      if (!target) continue;
      notifyRules.push({ kind: asString(o.kind) ?? "sender", target });
    }
  }
  /**
   * The scope a document states, deduped — or `undefined` for both "not stated" and "stated with
   * the wrong type". The caller tells those two apart by whether the key is present at all.
   *
   * THROUGH `readAwayPiles`, the leaf's one narrowing, at the `"document"` door: an unknown
   * member is a NEWER ohmail's and travels on, which is the whole difference from the request
   * contract's door and the reason both now name the same function — see {@link AwayPilesDoor}.
   */
  const pilesOf = (v: unknown): string[] | undefined => {
    const read = readAwayPiles(v, "document");
    return read.state === "stated" ? read.piles : undefined;
  };
  let awayResponder: ProfileAwayResponder | null = null;
  if (typeof raw.awayResponder === "object" && raw.awayResponder !== null) {
    const o = raw.awayResponder as Record<string, unknown>;
    awayResponder = {
      enabled: typeof o.enabled === "boolean" ? o.enabled : false,
      // `o.subject` is deliberately NOT read — the responder is reply-only since 0087, and a
      // document from an older ohmail carries a subject that has nowhere to go.
      body: asString(o.body),
      startsAt: asString(o.startsAt),
      endsAt: asString(o.endsAt),
      audience: asString(o.audience) ?? "screened_in",
      // `per_day` for a document that predates the field, which is the rate every row migrated by
      // 0087 carries. The importer narrows an UNRECOGNISED member to the same value; this only
      // fills in an absent one, and the two are separate on purpose (a member we do not know is a
      // newer ohmail's, and is a different fact from a field that was never written).
      throttle: asString(o.throttle) ?? "per_day",
      // ABSENT STAYS ABSENT. See the field: no default here, because "unstated" and "the Ohbox"
      // are different facts and only the importer can tell what to do with the first. DEDUPED,
      // because the value is a set at every other door and the notice renders one line per member.
      ...(pilesOf(o.piles) === undefined ? {} : { piles: pilesOf(o.piles) }),
    };
    /* A KNOWN KEY WITH THE WRONG TYPE IS NOT AN ABSENT ONE, and reading it as absent is the
       widening door: a document saying `enabled: true` with a wider `audience` and a malformed
       scope would turn the responder on and change who it answers while the one field that bounds
       its reach came from nowhere. The section is unreadable, which is the refusal an unparseable
       date already gets — applied whole or not at all. CHECKED BEFORE the object above is built,
       or the read of a non-array throws instead of refusing. */
    if (o.piles !== undefined && o.piles !== null && pilesOf(o.piles) === undefined) {
      awayResponder = null;
    }
  }
  const tagNames: string[] = Array.isArray(raw.tagNames)
    ? raw.tagNames.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
  // ABSENT AND null BOTH PARSE TO null — see the field's own comment. `asString` already answers
  // undefined for a non-string, so a document carrying a number or an object here reads as "no
  // signature" rather than putting a stranger's value into an outgoing mail.
  const signature: string | null = asString(raw.signature) ?? null;
  /* ABSENT, null AND A NON-STRING ALL PARSE TO "no markup" — the field's own rule. Kept as an
     OPTIONAL key on the way out rather than an explicit `null` so a document that carried none
     round-trips to the same bytes and the same fingerprint; `canonicalizeProfilePayload` drops
     it again for a payload with no text, so the two halves cannot come apart here either. */
  const signatureHtml = asString(raw.signatureHtml);
  return {
    screener, rules, notifyRules, awayResponder, tagNames, signature,
    ...(signature !== null && typeof signatureHtml === "string" && signatureHtml.trim().length > 0
      ? { signatureHtml } : {}),
  };
}

/**
 * Read one message. Returns `null` when it is not a profile at all (no discriminator) —
 * lease claims and future meta record types fall out here, exactly as profile messages fall out
 * of the lease's `parseClaim`.
 *
 * Duplicate discriminator headers are refused as `malformed` rather than resolved, for the
 * reason `parseClaim` documents at length: a record that announces itself and cannot be read
 * must never become invisible.
 */
export function parseProfileMessage(raw: string, ref?: unknown): ProfileRecord | null {
  const at = raw.search(/\r?\n\r?\n/);
  const headerBlock = at === -1 ? raw : raw.slice(0, at);
  const body = at === -1 ? "" : raw.slice(at).replace(/^\r?\n\r?\n/, "");

  const headers = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    headers.set(name, line.slice(colon + 1).trim());
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const get = (k: string): string | undefined => headers.get(k.toLowerCase());
  const count = (k: string): number => seen.get(k.toLowerCase()) ?? 0;
  const malformed = (reason: string): MalformedProfile =>
    ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref };

  if (count(H.profile) > 1) return malformed("duplicate profile header");
  if (get(H.profile) !== "1") return null; // not a profile — a lease claim, a stray, or a future record type
  if (count(H.installId) > 1) return malformed("duplicate install id header");

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return malformed("no document in body");

  const slice = body.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return malformed("document is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return malformed("document is not an object");
  }
  const rawDoc = parsed as Record<string, unknown>;
  const v = rawDoc.v;
  if (typeof v !== "number" || !Number.isInteger(v) || v < PROFILE_VERSION_MIN_READ) return malformed("unreadable version");

  const installId = get(H.installId) ?? null;
  if (v > PROFILE_VERSION) {
    return { status: "newer", v, installId, ...(ref === undefined ? {} : { ref }) };
  }

  /* THE ONE SPELLING THE WRITER EMITS. `updatedAt` decides which document is current, and any
     other string is parsed however the platform likes, so two installs could disagree about it. */
  const updatedAt = asString(rawDoc.updatedAt) ?? "";
  if (!isWrittenInstant(updatedAt)) return malformed("updatedAt is not the ISO form ohmail writes");

  const payload = readPayload(rawDoc);
  const producerRaw = typeof rawDoc.producer === "object" && rawDoc.producer !== null
    ? rawDoc.producer as Record<string, unknown> : {};
  const doc: OrganizerProfileDoc = {
    v,
    updatedAt,
    producer: {
      kind: asString(producerRaw.kind) ?? "unknown",
      version: asString(producerRaw.version) ?? "",
      // Only the literal `true` states complete stamps; anything else reads as an older copy.
      ...(producerRaw.stamped === true ? { stamped: true as const } : {}),
    },
    ...payload,
  };
  return { status: "ok", doc, v, installId, encoded: isEncodedAsWritten(slice, rawDoc), ...(ref === undefined ? {} : { ref }) };
}

/** Is this document slice exactly what this build writes for it — escapes, layout, key order? */
function isEncodedAsWritten(slice: string, rawDoc: Record<string, unknown>): boolean {
  try {
    return slice.replace(/\r\n/g, "\n") === serializeProfileDoc(rawDoc as unknown as OrganizerProfileDoc);
  } catch {
    return false;
  }
}

// ── IO ──────────────────────────────────────────────────────────────────────────────────────

/**
 * WHICH PROFILE OPERATION FAILED — the lease's `LeaseOp` discipline: a catch that wraps more
 * than one operation must name which one threw, and every member is a literal WE wrote, so it
 * costs nothing to log.
 */
export type ProfileOp = "ensure_meta" | "list_profiles" | "append_profile" | "remove_profiles" | "mark_seen";

/**
 * A profile IO failure is a mailbox fault for the LOGS, never for the pipeline: unlike the
 * lease, nothing about organizing hinges on this document, so callers log the failure and move
 * on — a mailbox whose profile cannot be written is a mailbox whose settings do not travel this
 * cycle, and the next cycle tries again.
 */
/**
 * THE FOLDER'S GENERATION, which is what says whether a remembered uid still means anything.
 *
 * The anchor itself now lives in `meta-memo.ts`, keyed by (install, mailbox) rather than beside
 * the connection: a reconnect changes nothing about the folder and must not cost the position,
 * and a position from a replaced numbering must not be usable at all.
 */
function generationOf(client: { readonly mailbox?: { uidValidity?: number | bigint } | false }): Generation {
  const selected = client.mailbox;
  const v = typeof selected === "object" && selected !== null ? selected.uidValidity : undefined;
  return typeof v === "number" || typeof v === "bigint" ? v : null;
}

/**
 * THE NAMED REFUSALS OF THE LISTING, in the alphabet a log line carries as `errorCode`. Each one
 * says "could not prove what the folder holds", never "it holds nothing": the writer once took an
 * empty header SEARCH as proof that no copy existed and appended a new one on every change.
 */
export type ProfileEnumCode =
  | "profile_no_count"
  | "profile_enum_incomplete"
  | "profile_meta_too_full"
  | "profile_enum_blind"
  | "profile_body_unavailable"
  | "profile_group_too_large";

/** The enumeration's refusal, in the profile's own names; the enumeration's code rides in `cause`. */
const PROFILE_ENUM_CODE: Readonly<Record<Exclude<MetaEnumCode, "read_deadline">, ProfileEnumCode>> = {
  no_count: "profile_no_count",
  over_ceiling: "profile_meta_too_full",
  bytes: "profile_meta_too_full",
  incomplete: "profile_enum_incomplete",
  headerless: "profile_enum_incomplete",
  generation_moved: "profile_enum_incomplete",
  blind: "profile_enum_blind",
};

export class ProfileUnavailableError extends Error {
  readonly op: ProfileOp;
  /**
   * The refusal's name, published to the log as `errorCode` — `log.ts#describeError` reads `code`
   * off the thrown value, so a code set here needs no call site to remember to extract it.
   */
  readonly code?: string;
  constructor(message: string, options: { op: ProfileOp; cause?: unknown; code?: string }) {
    super(message, options);
    this.name = "ProfileUnavailableError";
    this.op = options.op;
    if (options.code !== undefined) this.code = options.code;
  }
}

/** One settings message in the meta folder, as the IO layer sees it. */
export interface RawProfileMessage {
  ref: unknown;
  raw: string;
  /**
   * The folder's generation this message's `ref` was read under — REQUIRED, never optional. A
   * remembered uid is a fact only under its UIDVALIDITY: a renumbered folder re-issues the same
   * small integers to different messages. The io stamps every message in one call from ONE
   * `generationOf(client)` taken inside the same mailbox lock as the fetch, so the pair is
   * consistent by construction.
   */
  generation: Generation;
  /**
   * `raw` is the HEADER BLOCK only. The body was not read because a newer document decides what is
   * current; the header says whose copy this is, when it was written and at which version.
   */
  headerOnly?: true;
  /** The message's FLAGS at the listing; absent from an io that cannot say. */
  flags?: readonly string[];
}

/** A lease claim listed beside the settings: whose, and when it last beat. The tidy's fresh-writer test. */
export interface MetaClaimSeen {
  installId: string;
  heartbeat: Date;
}

/**
 * ONE LISTING: the settings messages and the lease claims enumerated beside them, as two fields, so
 * no copy or filter of the messages can lose the claims the tidy's fresh-writer test reads.
 */
export interface ProfileListing {
  messages: RawProfileMessage[];
  claims: readonly MetaClaimSeen[];
}

export interface ProfileListOptions {
  /** An over-budget body refuses instead of being skipped: the write and the tidy decide from this list. */
  complete?: boolean;
  /** Read these settings messages' bodies too, whatever their age — the write's read-back of its own append. */
  bodyFor?: (row: { ref: unknown; headerBlock: string }) => boolean;
}

/**
 * The narrow IO the profile needs. Same shape as the lease's {@link LeaseIo}, and not that
 * interface, because this one reads BODIES — the lease reads headers only, every cycle.
 */
export interface ProfileIo {
  /** Create `ohmail/_meta` if absent and unsubscribe it. Idempotent — the lease's semantics. */
  ensureMetaFolder(): Promise<void>;
  /**
   * The folder's settings messages, found by ONE header FETCH of the whole folder and checked against
   * the server's own message count, never by SEARCH. Bodies are read only for the newest documents,
   * the ones that decide what is current; every other settings message comes back `headerOnly`.
   */
  listProfileMessages(opts?: ProfileListOptions): Promise<RawProfileMessage[]>;
  /**
   * The same listing with the claims beside it — the real io's, which the read, the write and the
   * tidy use. A double without it lists whole sources, and its claims are read from those.
   */
  listMeta?(opts?: ProfileListOptions): Promise<ProfileListing>;
  /** APPEND one profile message, `\Seen`. */
  appendProfile(raw: string): Promise<void>;
  /** STORE `\Deleted` + EXPUNGE the given messages. */
  removeProfiles(refs: readonly unknown[]): Promise<void>;
  /** STORE `+FLAGS.SILENT (\Seen)` on one settings message. Optional: an io without it is not asked. */
  markSeen?(ref: unknown): Promise<void>;
}

/**
 * The minimum an IMAP client has to be for {@link makeProfileIo} to drive it. Structural, not
 * `ImapFlow`, for the lease's reason: the IO layer stays testable against a fake, and this
 * module never imports the client library.
 */
export interface ProfileImapClient extends MetaFolderClient {
  /* `uidValidity` is what says whether a remembered uid still refers to anything: a folder
   * deleted and recreated numbers from one again under a new generation. Optional because a
   * server may not have reported one yet, and an unknown generation is treated as a mismatch
   * rather than a match. */
  readonly mailbox?: { exists?: number; uidValidity?: number | bigint } | false;
  /** A NOOP. Optional, so every existing fake behaves exactly as it did. */
  noop?(): Promise<unknown>;
  /**
   * STATUS on a folder BY NAME — the only form of "how many messages" this module asks, because it
   * is the only one that answers with a single number. See {@link lastSequence}.
   */
  status?(
    path: string,
    query: { messages?: boolean; uidNext?: boolean },
  ): Promise<{ messages?: number; uidNext?: number } | false | undefined>;
  mailboxCreate(path: string): Promise<unknown>;
  mailboxUnsubscribe(path: string): Promise<unknown>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetch(
    range: string,
    /**
     * `source` may be a BYTE RANGE rather than a flag. `{ start, maxLength }` compiles to
     * `BODY.PEEK[]<start.maxLength>` (imapflow 1.5.0, `lib/commands/fetch.js`), which is the only
     * way to bound what a message costs BEFORE the server sends it. `headers: true` is
     * `BODY.PEEK[HEADER]`, the lease's own primitive.
     */
    query: {
      uid?: boolean;
      source?: boolean | { start?: number; maxLength?: number };
      size?: boolean;
      flags?: boolean;
      headers?: boolean;
      internalDate?: boolean;
    },
    options?: { uid?: boolean },
  ): AsyncIterableIterator<{
    uid: number; seq?: number; source?: Buffer; size?: number; flags?: Set<string>; headers?: Buffer;
    internalDate?: Date;
  }>;
  append(path: string, content: string | Buffer, flags?: string[]): Promise<unknown>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<unknown>;
  /** STORE `+FLAGS`; `silent` is `.SILENT`. Resolves `false` when the server refuses. */
  messageFlagsAdd?(range: number[], flags: string[], options?: { uid?: boolean; silent?: boolean }): Promise<unknown>;
}

/** The header block of a raw message: everything before the first blank line. */
function headerBlockOf(raw: string): string {
  const sep = /\r?\n\r?\n/.exec(raw);
  return sep ? raw.slice(0, sep.index) : raw;
}

/**
 * THE DATE GROUP a settings message falls in: its `Date` header's second. Every ohmail writer
 * writes `Date` as `updatedAt` cut to the second (`toUTCString`), but a server may serve the same
 * instant in RFC 5322's numeric-zone spelling, and the write's read-back, the held record's locator
 * and the listing's groups all compare this second. So the INSTANT is read, from an RFC 5322
 * date-time only (weekday checked when present, zone `GMT`, `UT`, `UTC` or `±hhmm`); any other
 * spelling is `null`, and a copy with no date group is kept, never removed.
 */
function dateSecondOf(headerBlock: string): number | null {
  const m = /^Date[ \t]*:(.*)$/im.exec(headerBlock.replace(/\r?\n[ \t]+/g, " "));
  // A trailing comment (`+0000 (UTC)`) is RFC 5322 CFWS: the instant is the text before it.
  const text = m ? m[1]!.replace(/(?:[ \t]*\([^()]*\))+[ \t]*$/, "").trim().replace(/[ \t]+/g, " ") : "";
  const d = m ? RFC5322_DATE.exec(text) : null;
  if (d === null) return null;
  const [, weekday, day, mon, year, hh, mm, ss, zone] = d;
  const month = (MONTHS as readonly string[]).indexOf(mon!);
  const local = Date.UTC(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss ?? "0"));
  const check = new Date(local);
  if (check.getUTCDate() !== Number(day) || Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? "0") > 60) return null;
  if (weekday !== undefined && WEEKDAYS[check.getUTCDay()] !== weekday) return null;
  const offset = /^[+-]\d{4}$/.test(zone!)
    ? (zone![0] === "-" ? -1 : 1) * (Number(zone!.slice(1, 3)) * 60 + Number(zone!.slice(3))) : 0;
  return Math.floor((local - offset * 60_000) / 1000);
}

/** RFC 5322 `date-time`: `[Mon, ]28 Sep 2026 10:00[:00] GMT|UT|UTC|+hhmm` — never the obsolete letter zones. */
const RFC5322_DATE = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ?)?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))? (GMT|UTC?|[+-]\d{4})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * A {@link ProfileIo} bound to a LIVE connection — the same connection the adapter already
 * holds, for the lease's reason: a second login per mailbox per cycle is how a provider decides
 * to throttle a user.
 *
 * @param limits Ceilings this IO enforces. Present so the BYTE ceiling can be observed at a size a
 * test can hold: it defaults to {@link PROFILE_BYTES_MAX_PER_FETCH}. No caller in the product passes
 * it, asserted by the census in `organizer-profile-bounded.test.ts`.
 */
export function makeProfileIo(
  client: ProfileImapClient,
  toServerPath: (canonical: string) => string,
  identity: MetaIdentity,
  limits?: { maxBytes?: number; now?: () => number },
): ProfileIo {
  assertMetaIdentity("makeProfileIo", identity);
  const maxBytes = limits?.maxBytes ?? PROFILE_BYTES_MAX_PER_FETCH;
  const now = limits?.now ?? Date.now;
  // The lease's resolution, not a second one. The profile and the claim share a folder, so a
  // second spelling of where that folder is would put the settings document and the lease in
  // different places on exactly the servers where it matters.
  const meta = makeMetaFolderRef(client, toServerPath);
  /**
   * THE GENERATION OF THE READ THAT NAMED THE REFS `removeProfiles` IS GIVEN — `null` until one
   * has been read. Held beside the connection rather than passed through the interface, so every
   * existing caller and fake keeps working and the pairing cannot be got wrong by a caller.
   */
  let generationAtLastRead: Generation = null;
  const refusal = (code: ProfileEnumCode, why: string, cause?: unknown): ProfileUnavailableError =>
    new ProfileUnavailableError(
      `the settings messages in ${META_FOLDER} could not be listed: ${why}`,
      { op: "list_profiles", code, ...(cause === undefined ? {} : { cause }) },
    );

  // `listMeta` takes the read's one budget here; the wrapper below enters it.
  const io: ProfileIo & { listMeta(opts?: ProfileListOptions, budget?: ImapDeadline): Promise<ProfileListing> } = {
    async ensureMetaFolder(): Promise<void> {
      const at = await meta.locate();
      const found = at.row;
      if (!found) {
        await createParentFirst(client, at.parent, "path");
        try {
          const info = await client.mailboxCreate(at.path);
          const landed = (info as { path?: string } | undefined)?.path;
          if (typeof landed === "string" && landed !== "") meta.adopt(landed);
        } catch (err) {
          if (!/already exists/i.test(String((err as Error).message))) throw err;
        }
      }
      if (!found || found.subscribed) await client.mailboxUnsubscribe(await meta.path());
    },

    /**
     * ONE HEADER FETCH OF THE WHOLE FOLDER, then bodies for the documents that decide.
     *
     * `UID FETCH 1:* (UID FLAGS BODY.PEEK[HEADER])` is the lease's own primitive, and it is checked
     * against STATUS: fewer rows than the server counts refuses by name, and our own last document
     * is the positive control that the header read sees settings messages at all. An empty answer
     * is a finding only when it is complete. Bodies go newest Date-second first, until one group
     * holds a readable document; a pile of any size costs one header FETCH and one body.
     */
    async listMeta(opts?: ProfileListOptions, budget: ImapDeadline = metaReadBudget(now)): Promise<ProfileListing> {
      const metaPath = await meta.path(budget);
      const lock = await client.getMailboxLock(metaPath);
      try {
        const claims: MetaClaimSeen[] = [];
        const out: RawProfileMessage[] = [];
        /* A cached zero may END the read, as ever (a stale zero costs a read that finds nothing);
           it never licenses one — the enumeration refuses without the server's own count. */
        const selected = client.mailbox;
        const cached = typeof selected === "object" && selected !== null ? selected.exists : undefined;
        /* THE POSITIVE CONTROL: our own last document, by the uid the server gave it, judged by the
           enumeration through the same path as every other row. */
        const remembered = readMemo(identity, generationOf(client));
        const ownUid = remembered.kind === "memo" && typeof remembered.memo.profileUid === "number"
          ? remembered.memo.profileUid : null;
        let listed: Awaited<ReturnType<typeof enumerateMetaFolder>>;
        try {
          listed = await enumerateMetaFolder(client, metaPath, budget, {
            keep: (h) => looksLikeProfile(h) || parseClaim(h) !== null,
            probe: ownUid === null ? null : { uid: ownUid, recognised: looksLikeProfile },
          });
        } catch (err) {
          if (!(err instanceof MetaEnumRefusedError)) throw err;
          if (err.code === "no_count" && cached === 0) {
            generationAtLastRead = generationOf(client);
            return { messages: out, claims };
          }
          // The outer race already names a spent clock; hand it the clock's own refusal.
          if (err.code === "read_deadline") throw err.cause ?? err;
          throw refusal(PROFILE_ENUM_CODE[err.code], err.message, err);
        }
        const generation = listed.generation;
        generationAtLastRead = generation;
        if (listed.probe === "absent") forgetMemo(identity, "profileUid");

        type Row = { uid: number; headerBlock: string; flags: readonly string[] };
        const profiles: Row[] = [];
        for (const r of listed.records) {
          if (looksLikeProfile(r.raw)) { profiles.push({ uid: r.ref, headerBlock: headerBlockOf(r.raw), flags: r.flags }); continue; }
          // The server-stamped heartbeat, the one the election ranks by (`withServerClock`).
          const claim = parseClaim(r.raw, r.ref, r.internalDate);
          if (claim !== null && !isMalformed(claim)) {
            const [stamped] = withServerClock([claim]);
            if (stamped !== undefined && !isMalformed(stamped)) claims.push({ installId: stamped.installId, heartbeat: stamped.heartbeat });
          }
        }
        profiles.sort((x, y) => x.uid - y.uid);

        /* A NEWER FORMAT IN ANY HEADER ENDS THE READ HERE: nothing beside it is written or removed,
           so no body is needed, and no flood of other records can push it out of view. */
        if (profiles.some((r) => { const v = shapeOf(r.headerBlock).version; return typeof v === "number" && v > PROFILE_VERSION; })) {
          for (const r of profiles) out.push({ ref: r.uid, raw: r.headerBlock, generation, headerOnly: true, flags: r.flags });
          return { messages: out, claims };
        }

        /* WHICH BODIES: the unparseable-Date group, then Date seconds newest first until a group
           holds a readable (or newer) document, plus whatever `bodyFor` names. Newest uid first
           inside a group, so the byte budget is spent on the current document before an old one. */
        const groups = new Map<number, Row[]>();
        const undated: Row[] = [];
        for (const r of [...profiles].reverse()) {
          const second = dateSecondOf(r.headerBlock);
          if (second === null) { undated.push(r); continue; }
          groups.set(second, [...(groups.get(second) ?? []), r]);
        }
        const complete = opts?.complete === true;
        const bodies = new Map<number, string>();
        const attempted = new Set<number>();
        let held = 0;
        let oversized = 0;
        const fetchSourceBounded = async (uid: number, budget: number): Promise<Buffer | { over: number } | null> => {
          const cap = Math.max(1, budget) + 1;
          for await (const m of client.fetch(String(uid), { uid: true, source: { start: 0, maxLength: cap } }, { uid: true })) {
            if (!m.source) continue;
            // An over-budget reply still cost its bytes, and says so.
            if (m.source.byteLength >= cap) return { over: m.source.byteLength };
            return m.source;
          }
          return null;
        };
        const readBody = async (r: Row): Promise<"ok" | "newer" | "other"> => {
          if (attempted.has(r.uid)) return "other";
          attempted.add(r.uid);
          if (bodies.size >= PROFILE_MESSAGES_MAX_PER_FETCH) {
            throw refusal("profile_group_too_large", `more than ${PROFILE_MESSAGES_MAX_PER_FETCH} settings `
              + "messages share the newest dates, and a read takes at most that many bodies");
          }
          const got = await fetchSourceBounded(r.uid, maxBytes - held);
          if (got === null) {
            /* A body that did not come back: absent now is an expunge in between; present is a refusal. */
            for await (const m of client.fetch(String(r.uid), { uid: true }, { uid: true })) {
              if (m.uid === r.uid) {
                throw refusal("profile_body_unavailable", "a listed settings message would not send its body");
              }
            }
            return "other";
          }
          if ("over" in got) {
            held += got.over;
            if (complete) {
              throw new ProfileUnavailableError(
                `a settings record in ${META_FOLDER} is larger than the ${maxBytes}-byte budget `
                + "this read may spend, and a write must see every document whole before it may "
                + "replace any",
                { op: "list_profiles" },
              );
            }
            oversized += 1;
            return "other";
          }
          held += got.byteLength;
          const raw = got.toString("utf8");
          bodies.set(r.uid, raw);
          const parsed = Buffer.byteLength(raw, "utf8") > PROFILE_DOC_MAX_BYTES ? null : parseProfileMessage(raw, r.uid);
          if (parsed === null || isMalformedProfile(parsed)) return "other";
          return parsed.status === "ok" ? "ok" : "newer";
        };
        for (const r of undated) await readBody(r);
        for (const second of [...groups.keys()].sort((a, b) => b - a)) {
          const verdicts: string[] = [];
          for (const r of groups.get(second)!) verdicts.push(await readBody(r));
          if (verdicts.includes("ok") || verdicts.includes("newer")) break;
        }
        for (const r of profiles) {
          if (opts?.bodyFor?.({ ref: r.uid, headerBlock: r.headerBlock })) await readBody(r);
        }
        if (bodies.size === 0 && oversized > 0) {
          throw new ProfileUnavailableError(
            `the only settings record in ${META_FOLDER} is larger than the ${maxBytes}-byte `
            + "budget this read may spend, so it was not transferred and cannot be parsed — "
            + "answering with nothing here would say no settings have been published",
            { op: "list_profiles" },
          );
        }
        /* A body asked for and not kept was skipped (over budget, or expunged in between); it is
           left out, as it always was. One never asked for is listed by its header. */
        for (const r of profiles) {
          const body = bodies.get(r.uid);
          if (body !== undefined) out.push({ ref: r.uid, raw: body, generation, flags: r.flags });
          else if (!attempted.has(r.uid)) out.push({ ref: r.uid, raw: r.headerBlock, generation, headerOnly: true, flags: r.flags });
        }
        return { messages: out, claims };
      } finally {
        lock.release();
      }
    },

    async listProfileMessages(opts?: ProfileListOptions): Promise<RawProfileMessage[]> {
      return (await io.listMeta(opts)).messages;
    },

    async appendProfile(raw: string): Promise<void> {
      /* UNDER `_meta`'S OWN LOCK: the client drops an APPEND flag the SELECTED folder's
         PERMANENTFLAGS do not permit, and this connection may have another folder selected. */
      const path = await meta.path();
      const lock = await client.getMailboxLock(path);
      let reply: unknown;
      try {
        reply = await client.append(path, raw, ["\\Seen"]);
      } finally {
        lock.release();
      }
      // No UIDPLUS means no anchor rather than a guessed one.
      const uid = typeof reply === "object" && reply !== null
        ? (reply as { uid?: unknown }).uid
        : undefined;
      /* The generation comes from the APPEND's own reply: UIDPLUS reports the uid and the
         generation together, so taken from there they are consistent by construction. */
      const gen = typeof reply === "object" && reply !== null
        ? (reply as { uidValidity?: unknown }).uidValidity
        : undefined;
      const generation = typeof gen === "number" || typeof gen === "bigint" ? gen : null;
      if (typeof uid === "number" && Number.isFinite(uid) && uid > 0 && generation !== null) {
        writeMemo(identity, generation, { profileUid: uid });
      } else {
        forgetMemo(identity, "profileUid");
      }
    },

    async removeProfiles(refs: readonly unknown[]): Promise<void> {
      const uids = refs.filter((r): r is number => typeof r === "number");
      if (uids.length === 0) return;
      const lock = await client.getMailboxLock(await meta.path());
      try {
        /**
         * THESE REFS CAME OUT OF A READ, AND A UID IS A FACT ONLY UNDER THE NUMBERING IT WAS READ
         * UNDER. `ohmail/_meta` can be replaced between that read and this lock, and the numbers
         * then name whatever sits at them now — another install's settings document, a live claim.
         * The one guard, and the fail-open arm the other two cleanups decided: only a PROVEN
         * mismatch refuses, because a connection that never states a UIDVALIDITY would otherwise
         * never be able to prune its own older copies, and the custody read-back below is the
         * backstop. `writeOrganizerProfile` logs a refusal here and keeps the write, which is
         * right: the new document is in the folder either way.
         */
        const refEpoch = epochOf(generationAtLastRead);
        const nowEpoch = epochOf(generationOf(client));
        if (uidRefsAtEpoch(uids.map((uid) => ({ epoch: refEpoch, uid })), nowEpoch) === "stale") {
          throw new ProfileUnavailableError(
            `${META_FOLDER} was renumbered between the read that named these ${uids.length} `
            + "settings message(s) and the delete, so the refs cannot be trusted and nothing was "
            + "expunged",
            { op: "remove_profiles" },
          );
        }
        /* THE RESULT IS READ, AND THEN CHECKED AGAINST THE FOLDER. `messageDelete` resolves
         * `false` when the server refuses — it does not reject — and this discarded that, so a
         * refused cleanup was reported as a completed one and every prior document stayed. Worse,
         * a `true` proves only that an EXPUNGE ran: the STORE that marks `\Deleted` is internal to
         * the library and its result is not propagated, so a refused store with an accepted expunge
         * removes nothing and still resolves `true`. Custody is read back. */
        const done = await client.messageDelete(uids, { uid: true });
        if (done === false) {
          throw new ProfileUnavailableError(
            `the server refused to expunge ${uids.length} settings message(s) from ${META_FOLDER}`,
            { op: "remove_profiles" },
          );
        }
        if (typeof client.fetch === "function") {
          const still: number[] = [];
          try {
            for await (const m of client.fetch(uids.join(","), { uid: true }, { uid: true })) {
              if (typeof m.uid === "number") still.push(m.uid);
            }
          } catch (err) {
            /* The lease's rule, and for the same reason: a custody read that could not RUN proves
             * nothing in either direction, and returning normally here reports removal to a caller
             * that counts it. `writeOrganizerProfile` sets `removed = oldRefs.length` from a normal
             * return, so the count described settings documents that may still be in the folder. */
            throw new ProfileUnavailableError(
              `the expunge of ${uids.length} settings message(s) from ${META_FOLDER} could not be `
              + `verified: ${err instanceof Error ? err.message : String(err)}`,
              { op: "remove_profiles" },
            );
          }
          if (still.length > 0) {
            throw new ProfileUnavailableError(
              `${still.length} settings message(s) survived the expunge in ${META_FOLDER}`,
              { op: "remove_profiles" },
            );
          }
        }
      } finally {
        lock.release();
      }
    },

    async markSeen(ref: unknown): Promise<void> {
      if (typeof ref !== "number" || typeof client.messageFlagsAdd !== "function") return;
      const lock = await client.getMailboxLock(await meta.path());
      try {
        /* The uid came out of a read, and a uid is a fact only under the numbering it was read
           under: the same guard as `removeProfiles`, for one flag on one message. */
        if (uidRefsAtEpoch([{ epoch: epochOf(generationAtLastRead), uid: ref }], epochOf(generationOf(client))) === "stale") {
          throw new ProfileUnavailableError(
            `${META_FOLDER} was renumbered between the read and the flag, so nothing was marked`,
            { op: "mark_seen" },
          );
        }
        const done = await client.messageFlagsAdd([ref], ["\\Seen"], { uid: true, silent: true });
        if (done === false) {
          throw new ProfileUnavailableError(`the server refused to mark a settings message seen`, { op: "mark_seen" });
        }
      } finally {
        lock.release();
      }
    },
  };

  /**
   * The read gets a wall clock; the writes deliberately do not. One budget for the whole read,
   * because per-command clocks compose into a total nobody bounded. A breach abandons a command
   * the driver is still running, so the connection is finished — both callers close it — and an
   * abandoned APPEND could still land, which is why the writes are not raced.
   */
  const raced = (opts?: ProfileListOptions): Promise<ProfileListing> => {
    const budget = metaReadBudget(now);
    return budget.race(io.listMeta(opts, budget), META_FOLDER);
  };
  return {
    ...io,
    listMeta: raced,
    listProfileMessages: async (opts?: ProfileListOptions): Promise<RawProfileMessage[]> => (await raced(opts)).messages,
  };
}

// ── READ ────────────────────────────────────────────────────────────────────────────────────

/**
 * What a read of the folder found — the caller's vocabulary for the whole feature: `found` — a
 * readable document; `doc` is it, `installId` who wrote it (or null). `none` — no profile message
 * at all; defaults apply, never an error. `newer` — the newest thing was written by a later
 * format; the caller must not overwrite it and cannot import from it: "written by a newer
 * ohmail". `unreadable` — only corrupt profile message(s); reported, and replaceable by the next
 * write, since a corrupt copy of our own bookkeeping carries nothing recoverable.
 */
export type ProfileReadResult =
  | {
    state: "found"; doc: OrganizerProfileDoc; installId: string | null; ref: unknown;
    /**
     * `false` when the chosen message's body is still in the plain form ({@link
     * ParsedProfileMessage.encoded}); only `false` asks the holder to rewrite it, so absent writes nothing.
     */
    encoded?: boolean;
    /**
     * The generation `ref` was read under (mail 0094's mirror writer needs it). `ref` alone is a
     * uid, and storing one without its generation is the defect this pair prevents. This value
     * comes from the same lock as the fetch. `null` means the server did not report one — an
     * unusable locator, never "any generation will do".
     */
    generation: Generation;
    /**
     * How many settings messages beside the chosen one the tidy would remove ({@link
     * tidyOrganizerProfile}'s selector, taken as the chosen document's writer). A caller that sees
     * a non-zero residue owes a tidy, never a rewrite.
     */
    residue: number;
  }
  | { state: "none" }
  | { state: "newer"; v: number }
  | { state: "unreadable"; reason: string };

/**
 * The largest profile message this build will parse. The document is the body, handed to
 * `JSON.parse`, and nothing bounded that: a 500 MB message in `ohmail/_meta` was a 500 MB string,
 * a parse, and a canonical re-serialization, all inside one request. Generous, not tight, because
 * ohmail writes this message itself: a multiple of the largest document the import would ever
 * ACCEPT, and still FINITE, which is the property being bought.
 */
export const PROFILE_DOC_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The most settings BODIES one read of `ohmail/_meta` fetches. Only the newest documents are read
 * by body, so at rest a read fetches one; this bounds a folder where many settings messages share
 * the newest Date second, which no ohmail writer produces.
 */
export const PROFILE_MESSAGES_MAX_PER_FETCH = 500;

/**
 * The byte ceiling on the bodies one read fetches. Whoever can append chooses which ceiling to
 * spend, so both exist — the count stops many small messages, this stops a few enormous ones.
 */
export const PROFILE_BYTES_MAX_PER_FETCH = 128 * 1024 * 1024;

/**
 * THE REFUSAL'S NAME, CARRIED THROUGH THE WRAPPER: `describeCause` walks a BOUNDED chain, so a code
 * two wrappers down reaches no line at all. Forwarding it means one field names the refusal.
 */
function askCodeOf(err: unknown): string | undefined {
  return err instanceof ProfileUnavailableError ? err.code : undefined;
}

/** A `MalformedProfile`, with `ref` omitted rather than set to `undefined` (the parser's rule). */
function malformedProfile(reason: string, ref: unknown): MalformedProfile {
  return ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref };
}

/**
 * THE DOCUMENT A READER TAKES — newest `updatedAt`, ties broken as below. One rule, so the read,
 * the write and the tidy agree on which document is current.
 */
function newestOf(ok: readonly ParsedProfileMessage[]): ParsedProfileMessage {
  return [...ok].sort((a, b) => {
    // Both are the writer's ISO spelling — the parser admits no other — so both parse the same everywhere.
    const d = Date.parse(b.doc!.updatedAt) - Date.parse(a.doc!.updatedAt);
    if (d !== 0) return d;
    /* THE SAME RULE AS `byCodeUnit`'s header, and this one decides WHICH DOCUMENT WINS: under
       `localeCompare` two installs reading the same folder could pick DIFFERENT documents. */
    const byDoc = byCodeUnit(JSON.stringify(b.doc), JSON.stringify(a.doc));
    if (byDoc !== 0) return byDoc;
    /* Identical timestamp and document, different records: `ref` DESCENDING, because the ref is
       the uid and a higher uid IS a later write. `installId` is the final tie-break, where it
       decides nothing observable. */
    const refA = Number(a.ref);
    const refB = Number(b.ref);
    if (Number.isFinite(refA) && Number.isFinite(refB) && refA !== refB) return refB - refA;
    return byCodeUnit(String(b.ref ?? ""), String(a.ref ?? ""))
      || byCodeUnit(String(a.installId ?? ""), String(b.installId ?? ""));
  })[0]!;
}

/**
 * A line naming the discriminator, ANCHORED at a line start: the one test of "this header says it
 * is a settings message", shared by the listing's filter, the header-only reading and the tidy's
 * shape test. `X-Forwarded-X-Ohmail-Profile:` is not it, and neither is a mention in the body.
 */
const PROFILE_HEADER_LINE = /^X-Ohmail-Profile[ \t]*:(.*)$/gim;

/** The values of every anchored discriminator line in a header block, unfolded and trimmed. */
function discriminatorValues(headerBlock: string): string[] {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  return [...unfolded.matchAll(PROFILE_HEADER_LINE)].map((m) => m[1]!.trim());
}

/** Header values by lowercased name, in order, unfolded. */
function headerValues(headerBlock: string, name: string): string[] {
  const out: string[] = [];
  const want = name.toLowerCase();
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === want) out.push(line.slice(colon + 1).trim());
  }
  return out;
}

/**
 * WHAT A SETTINGS MESSAGE'S HEADER SAYS about it. `exact` is the tidy's first condition: one anchored
 * `X-Ohmail-Profile: 1`, one non-empty `X-Ohmail-Install-Id`, and the Subject every ohmail writer has
 * used since v1. `version` is the `X-Ohmail-Profile-Version` header: `null` absent, which means 1 or 2.
 */
interface ProfileShape {
  exact: boolean;
  why: string;
  installId: string | null;
  dateSecond: number | null;
  version: number | null | "unreadable";
}

function shapeOf(headerBlock: string): ProfileShape {
  const discriminators = discriminatorValues(headerBlock);
  const ids = headerValues(headerBlock, H.installId);
  const subjects = headerValues(headerBlock, "Subject");
  const versions = headerValues(headerBlock, H.version);
  const v = versions.length === 0 ? null
    : versions.length === 1 && /^\d+$/.test(versions[0]!) ? Number(versions[0]) : "unreadable";
  const installId = ids.length === 1 && ids[0] !== "" ? ids[0]! : null;
  const why = discriminators.length !== 1 || discriminators[0] !== "1" ? "the settings header is not exactly one `1`"
    : installId === null ? "no single install id"
      : subjects.length !== 1 || `Subject: ${subjects[0]}` !== PROFILE_SUBJECT_HEADER ? "another subject"
        : "";
  return { exact: why === "", why, installId, dateSecond: dateSecondOf(headerBlock), version: v };
}

/**
 * A SETTINGS MESSAGE READ BY ITS HEADER ALONE. `newer`: its version header is above {@link
 * PROFILE_VERSION}, and nothing is written or removed beside it. `unrecognised`: it says it is a
 * settings message without the ohmail shape, and it is never removed. `superseded`: an ohmail copy
 * older than the documents read by body. `null`: not a settings message at all.
 */
export type HeaderOnlyClass =
  | { kind: "newer"; v: number }
  | { kind: "unrecognised"; reason: string }
  | { kind: "superseded"; installId: string; dateSecond: number | null };

export function classifyHeaderOnly(headerBlock: string): HeaderOnlyClass | null {
  const discriminators = discriminatorValues(headerBlock);
  if (discriminators.length === 0) return null;
  const shape = shapeOf(headerBlock);
  if (typeof shape.version === "number" && shape.version > PROFILE_VERSION) return { kind: "newer", v: shape.version };
  if (discriminators.length === 1 && discriminators[0] !== "1") return null;
  if (!shape.exact || shape.version === "unreadable") {
    return { kind: "unrecognised", reason: shape.exact ? "an unreadable version header" : shape.why };
  }
  return { kind: "superseded", installId: shape.installId!, dateSecond: shape.dateSecond };
}

/** One settings message of a listing, as the read, the write and the tidy all see it. */
interface ProfileEntry {
  msg: RawProfileMessage;
  shape: ProfileShape;
  /** The body's parse, when the body was read. */
  record: ProfileRecord | null;
  /** The header's reading, when only the header was. */
  header: HeaderOnlyClass | null;
}

interface ProfileView {
  entries: ProfileEntry[];
  /** The highest newer version seen by body or by header, or `null`. */
  newerV: number | null;
  ok: ParsedProfileMessage[];
  current: ProfileEntry | null;
}

/** The one reading of a listing. The parser decides what a body means; the header decides the rest. */
function viewOf(messages: readonly RawProfileMessage[]): ProfileView {
  const entries: ProfileEntry[] = [];
  let newerV: number | null = null;
  const newer = (v: number): void => { newerV = newerV === null ? v : Math.max(newerV, v); };
  for (const m of messages) {
    const block = m.headerOnly === true ? m.raw : headerBlockOf(m.raw);
    const shape = shapeOf(block);
    if (m.headerOnly === true) {
      const header = classifyHeaderOnly(block);
      if (header === null) continue;
      if (header.kind === "newer") newer(header.v);
      entries.push({ msg: m, shape, record: null, header });
      continue;
    }
    // BEFORE the parse: an oversized message is MALFORMED, a copy of our bookkeeping we cannot read.
    const record = Buffer.byteLength(m.raw, "utf8") > PROFILE_DOC_MAX_BYTES
      ? malformedProfile(`the saved settings message is larger than ${PROFILE_DOC_MAX_BYTES} bytes`, m.ref)
      : parseProfileMessage(m.raw, m.ref);
    if (record === null) continue;
    if (!isMalformedProfile(record) && record.status === "newer") newer(record.v);
    if (typeof shape.version === "number" && shape.version > PROFILE_VERSION) newer(shape.version);
    entries.push({ msg: m, shape, record, header: null });
  }
  const ok = entries
    .map((e) => e.record)
    .filter((r): r is ParsedProfileMessage => r !== null && !isMalformedProfile(r) && r.status === "ok");
  const chosen = ok.length > 0 ? newestOf(ok) : null;
  return { entries, newerV, ok, current: chosen === null ? null : entries.find((e) => e.record === chosen)! };
}

/**
 * THE LISTING, from the real io's `listMeta`, or from a double's whole sources, where the claims are
 * elements among the messages and are read from them.
 */
async function listingOf(io: ProfileIo, opts?: ProfileListOptions): Promise<ProfileListing> {
  if (typeof io.listMeta === "function") return io.listMeta(opts);
  const messages = await io.listProfileMessages(opts);
  const claims: MetaClaimSeen[] = [];
  for (const m of messages) {
    if (m.headerOnly === true) continue;
    const c = parseClaim(m.raw, m.ref);
    if (c !== null && !isMalformed(c)) claims.push({ installId: c.installId, heartbeat: c.heartbeat });
  }
  return { messages, claims };
}

/**
 * THE SETTINGS MESSAGE ANOTHER INSTALL LEFT WHILE THIS ORGANIZER ASKS ABOUT IT — named by what its
 * header says (the install id and the Date second, the writer's `isOurs` shape) and proved by its
 * fingerprint. The write, the tidy and the reads keep it until the question is answered; a
 * locator that matches nothing is a record that is gone.
 */
export interface ProfileLocator { installId: string; second: number; fingerprint: string }

/** The locator of a document read from the folder, or `null` where its writer named no install. */
export function profileLocatorOf(installId: string | null, doc: OrganizerProfileDoc): ProfileLocator | null {
  if (installId === null || installId === "") return null;
  return { installId, second: Math.floor(Date.parse(doc.updatedAt) / 1000), fingerprint: profileFingerprint(doc) };
}

/** Does this header name the located record — the body read and the fingerprint decide the rest. */
function namesLocated(headerBlock: string, at: ProfileLocator): boolean {
  const s = shapeOf(headerBlock);
  return s.installId === at.installId && s.dateSecond === at.second;
}

/** The entry the locator names, read by body and saying what the locator says, or `null`. */
function locatedIn(view: ProfileView, at: ProfileLocator | undefined): ProfileEntry | null {
  if (at === undefined) return null;
  return view.entries.find((e) => e.record !== null && !isMalformedProfile(e.record) && e.record.status === "ok"
    && e.shape.installId === at.installId && e.shape.dateSecond === at.second
    && profileFingerprint(e.record.doc!) === at.fingerprint) ?? null;
}

/** This install's newest settings message, read by body or header — what its next write replaces. */
function ownNewest(view: ProfileView, installId: string): ProfileEntry | null {
  const uid = (e: ProfileEntry): number => (typeof e.msg.ref === "number" ? e.msg.ref : -1);
  return view.entries
    .filter((e) => e.shape.exact && e.shape.installId === installId)
    .sort((a, b) => (b.shape.dateSecond ?? -1) - (a.shape.dateSecond ?? -1) || uid(b) - uid(a))[0] ?? null;
}

/** A listing that reads the located record's body too, whatever its age (one locator per call). */
function retainingList(at: ProfileLocator | undefined, opts: ProfileListOptions = {}): ProfileListOptions {
  if (at === undefined) return opts;
  const also = opts.bodyFor;
  return { ...opts, bodyFor: (row) => namesLocated(row.headerBlock, at) || (also?.(row) ?? false) };
}

/** The counts `profile_tidy_planned` carries — numbers only, never an address, subject or folder. */
export interface TidyCounts {
  records: number;
  current: 0 | 1;
  removable: number;
  own: number;
  foreignStale: number;
  duplicate: number;
  /** A record of a question this organizer held and released ({@link ProfileLocator}). */
  released: number;
  malformed: number;
  keptForeignFresh: number;
  keptUnrecognised: number;
  /** An unreadable copy dated at or after the current document: not superseded, so kept. */
  keptNewerDated: number;
  /** The record held for an unanswered found-settings question ({@link ProfileLocator}). */
  keptHeld: number;
  /** This install's own copy, kept while the current document is another install's it has not seen. */
  keptOwnBesideUnseen: number;
  unseenCurrent: 0 | 1;
}

/**
 * THE ONE SELECTOR — which settings messages beside the current document C may go.
 *
 * Only an ohmail-shaped copy (the header's `exact`), only while nothing newer is in the folder, only
 * superseded by a readable C and never C itself. Then: its body is unreadable, it is this install's
 * (once C is its own, held or seen), it says what C says, it is a question the caller held and
 * released (`released`), or it is another install's copy ten minutes older than C whose writer holds
 * no fresh claim. Claims, acks, requests and mail carry no settings header. Oldest first, by uid.
 */
function planTidy(
  view: ProfileView, selfInstallId: string | null, now: Date, claims: readonly MetaClaimSeen[],
  retain?: ProfileLocator, released: readonly ProfileLocator[] = [], replaceable: ReadonlySet<string> = new Set(),
): { counts: TidyCounts; refs: unknown[] } {
  const counts: TidyCounts = {
    records: view.entries.length, current: 0, removable: 0, own: 0, foreignStale: 0, duplicate: 0, released: 0,
    malformed: 0, keptForeignFresh: 0, keptUnrecognised: 0, keptNewerDated: 0, keptHeld: 0, keptOwnBesideUnseen: 0, unseenCurrent: 0,
  };
  const held = locatedIn(view, retain);
  const C = view.current;
  if (view.newerV !== null || C === null) return { counts, refs: [] };
  counts.current = 1;
  counts.unseenCurrent = C.msg.flags !== undefined && !C.msg.flags.includes("\\Seen") ? 1 : 0;
  const cDoc = (C.record as ParsedProfileMessage).doc!;
  const cFingerprint = profileFingerprint(cDoc);
  /* THE WRITE'S OWN RULE: a current document another install wrote, which this install has not
     seen (`replaceable`) and does not hold, may be the one that holds THIS install's older copy as
     its question. This install's copies stay until it has seen it. */
  const cSeen = (C.record as ParsedProfileMessage).installId === selfInstallId || C === held || replaceable.has(cFingerprint);
  const freshClaim = (installId: string | null): boolean => claims.some((c) => c.installId === installId
    && now.getTime() - c.heartbeat.getTime() < DEFAULT_STALE_AFTER_MS);
  const older = (a: number | null, b: number | null): boolean => a !== null && b !== null && a < b;
  const picked: ProfileEntry[] = [];
  for (const e of view.entries) {
    if (e === C) continue;
    if (e === held) { counts.keptHeld += 1; continue; }
    if (!e.shape.exact || e.header?.kind === "unrecognised") { counts.keptUnrecognised += 1; continue; }
    const ok = e.record !== null && !isMalformedProfile(e.record) && e.record.status === "ok";
    /* SUPERSEDED: a readable body lost to C under `newestOf`; an unreadable body shares C's second
       or is older; a header-only copy is older by its Date. */
    const superseded = ok ? true
      : e.record !== null ? e.shape.dateSecond === C.shape.dateSecond || older(e.shape.dateSecond, C.shape.dateSecond)
        : older(e.shape.dateSecond, C.shape.dateSecond);
    if (!superseded) { counts.keptNewerDated += 1; continue; }
    if (e.record !== null && isMalformedProfile(e.record)
      && (e.shape.version === null || (typeof e.shape.version === "number" && e.shape.version <= PROFILE_VERSION))) {
      counts.malformed += 1;
    } else if (e.shape.installId === selfInstallId) {
      if (!cSeen) { counts.keptOwnBesideUnseen += 1; continue; }
      counts.own += 1;
    } else if (ok && profileFingerprint((e.record as ParsedProfileMessage).doc!, cDoc.v) === cFingerprint) {
      counts.duplicate += 1;
    } else if (released.some((at) => locatedIn(view, at) === e)) {
      counts.released += 1;
    } else if (C.shape.dateSecond !== null && e.shape.dateSecond !== null
      && (C.shape.dateSecond - e.shape.dateSecond) * 1000 >= DEFAULT_STALE_AFTER_MS
      && !freshClaim(e.shape.installId)) {
      counts.foreignStale += 1;
    } else {
      counts.keptForeignFresh += 1;
      continue;
    }
    picked.push(e);
  }
  counts.removable = picked.length;
  const uidOf = (e: ProfileEntry): number => (typeof e.msg.ref === "number" ? e.msg.ref : Number.MAX_SAFE_INTEGER);
  return { counts, refs: picked.sort((a, b) => uidOf(a) - uidOf(b)).map((e) => e.msg.ref) };
}

/**
 * READ `ohmail/_meta` AND SAY WHAT PROFILE IT HOLDS. Among readable documents the newest
 * `updatedAt` wins ({@link newestOf}). A single `newer` document anywhere, by body or by its version
 * header, DOMINATES every readable one: an older build must never conclude "the current profile is
 * the old one I can read" while a newer producer's document sits beside it.
 */
export async function readOrganizerProfile(
  io: ProfileIo,
  /**
   * `retain`: answer the located record when it is there, and leave it out of `residue`.
   * `foreignTo`: otherwise answer the newest document another install wrote, where one is there —
   * the question an organizer holds, which its own newer document beside it does not answer.
   */
  opts?: { installId?: string; now?: Date; retain?: ProfileLocator; foreignTo?: string },
): Promise<ProfileReadResult> {
  let listing: ProfileListing;
  try {
    listing = await listingOf(io, opts?.retain === undefined ? undefined : retainingList(opts.retain));
    /* A SERVER SENDS BODIES FOR THE NEWEST DATE ONLY, so the other install's document beside a
       newer own one arrives as a header. Asked for it, the read lists once more, taking the body
       of the newest record another install's header names — one body, never the whole folder. */
    const foreignTo = opts?.foreignTo;
    const first = foreignTo === undefined ? null : viewOf(listing.messages);
    if (foreignTo !== undefined && first !== null && first.newerV === null
      && !first.ok.some((r) => r.installId !== foreignTo)) {
      const pick = first.entries
        .filter((e) => e.record === null && e.shape.exact && e.shape.installId !== null && e.shape.installId !== foreignTo)
        .sort((a, b) => (b.shape.dateSecond ?? -1) - (a.shape.dateSecond ?? -1))[0];
      if (pick !== undefined) {
        const also: ProfileListOptions = opts?.retain === undefined ? {} : retainingList(opts.retain);
        listing = await listingOf(io, {
          ...also,
          bodyFor: (row) => {
            const s = shapeOf(row.headerBlock);
            return (s.installId === pick.shape.installId && s.dateSecond === pick.shape.dateSecond) || (also.bodyFor?.(row) ?? false);
          },
        });
      }
    }
  } catch (err) {
    throw new ProfileUnavailableError(
      `the organizer profile in ${META_FOLDER} could not be read`,
      { op: "list_profiles", cause: err, code: askCodeOf(err) },
    );
  }
  const { messages } = listing;
  const view = viewOf(messages);
  if (view.entries.length === 0) return { state: "none" };

  /**
   * The call's generation, and it must be ONE: every message in one listing comes from one SELECT
   * of one folder on one connection. A set reporting more than one is evidence the producer is
   * manufacturing the pair, refused as unreadable rather than resolved by picking one.
   */
  const generations = new Set(messages.map((m) => (
    typeof m.generation === "number" || typeof m.generation === "bigint" ? m.generation : null
  )));
  if (generations.size > 1) {
    return {
      state: "unreadable",
      reason: "the settings messages disagree about the folder's generation, so no locator among "
        + "them can be trusted",
    };
  }
  const generation: Generation = [...generations][0] ?? null;

  if (view.newerV !== null) return { state: "newer", v: view.newerV };
  if (view.current === null) {
    const first = view.entries.find((e) => e.record !== null && isMalformedProfile(e.record));
    return {
      state: "unreadable",
      reason: first !== undefined && first.record !== null && isMalformedProfile(first.record)
        ? first.record.reason : "unreadable profile",
    };
  }
  const foreign = opts?.foreignTo === undefined ? []
    : view.ok.filter((r) => r.installId !== opts.foreignTo);
  const newest = (locatedIn(view, opts?.retain)?.record
    ?? (foreign.length > 0 ? newestOf(foreign) : view.current.record)) as ParsedProfileMessage;
  const plan = planTidy(view, opts?.installId ?? newest.installId, opts?.now ?? new Date(), listing.claims, opts?.retain);
  return {
    state: "found", doc: newest.doc!, installId: newest.installId, ref: newest.ref,
    encoded: newest.encoded === true,
    /* THE ONE THE UID WAS READ UNDER — taken from the messages this read parsed, never from the
       connection at this moment. */
    generation,
    residue: plan.refs.length,
  };
}

// ── TIDY ────────────────────────────────────────────────────────────────────────────────────

/** How the organizer tidies: `remove` for real, or `count` — plan, log, remove nothing. */
export type ProfileTidyMode = "remove" | "count";

export interface TidyOutcome {
  removed: number;
  remaining: number;
  /** The plan the pass logged, or `null` when it refused before planning. */
  planned: TidyCounts | null;
  refused?: "newer";
}

type ProfileLog = (event: string, detail: Record<string, unknown>) => void;

/**
 * ONE TIDY PASS over a listing already in hand: log the plan's counts FIRST, then (in `remove`)
 * take the oldest `max` matches out in one custody-checked removal, then mark C seen. Never
 * appends. Shared by {@link tidyOrganizerProfile} and the write's gate.
 */
async function tidyPass(
  io: ProfileIo,
  view: ProfileView,
  plan: { counts: TidyCounts; refs: unknown[] },
  args: { mode: ProfileTidyMode; max: number; log: ProfileLog },
): Promise<TidyOutcome> {
  args.log("profile_tidy_planned", { ...plan.counts, tidyMode: args.mode });
  if (args.mode === "count") return { removed: 0, remaining: plan.refs.length, planned: plan.counts };
  const batch = plan.refs.slice(0, args.max);
  let removed = 0;
  if (batch.length > 0) {
    try {
      await io.removeProfiles(batch);
      removed = batch.length;
    } catch (err) {
      args.log("profile_cleanup_failed", {
        op: "remove_profiles" satisfies ProfileOp,
        err,
      });
    }
  }
  if (view.current !== null && plan.counts.unseenCurrent === 1 && typeof io.markSeen === "function") {
    try {
      await io.markSeen(view.current.msg.ref);
    } catch (err) {
      args.log("profile_cleanup_failed", {
        op: "mark_seen" satisfies ProfileOp,
        err,
      });
    }
  }
  const remaining = plan.refs.length - removed;
  args.log("profile_tidied", { removed, remaining });
  return { removed, remaining, planned: plan.counts };
}

/**
 * THE ORGANIZER'S TIDY of `ohmail/_meta`: remove superseded ohmail settings copies, at most
 * {@link PROFILE_TIDY_MAX_PER_PASS} per pass, oldest first, never the current document. Called
 * only from the live organizer's pass (`OrganizerProfileSync.onOrganize`); a census holds that.
 * Refuses and removes nothing while a newer-format document is in the folder.
 */
export async function tidyOrganizerProfile(input: {
  io: ProfileIo;
  installId: string;
  mode?: ProfileTidyMode;
  now?: Date;
  max?: number;
  log?: ProfileLog;
  /** The record held for an unanswered found-settings question: never removed. */
  retain?: ProfileLocator;
  /** Records of questions the caller held and released: removed beside its own, whatever their age. */
  released?: readonly ProfileLocator[];
  /** What the caller has seen, as for {@link WriteProfileInput}: absent, its own copies stay beside another install's current one. */
  replaceable?: readonly string[];
}): Promise<TidyOutcome> {
  const log = input.log ?? ((): void => undefined);
  const released = input.released ?? [];
  let listing: ProfileListing;
  try {
    listing = await listingOf(input.io, released.reduce(
      (opts: ProfileListOptions, at) => retainingList(at, opts), retainingList(input.retain, { complete: true }),
    ));
  } catch (err) {
    throw new ProfileUnavailableError(
      `the settings messages in ${META_FOLDER} could not be read before tidying`,
      { op: "list_profiles", cause: err, code: askCodeOf(err) },
    );
  }
  const { messages } = listing;
  const view = viewOf(messages);
  if (view.newerV !== null) {
    log("profile_tidy_refused", { reason: "newer" });
    return { removed: 0, remaining: 0, planned: null, refused: "newer" };
  }
  const plan = planTidy(view, input.installId, input.now ?? new Date(), listing.claims, input.retain, released, new Set(input.replaceable ?? []));
  return tidyPass(input.io, view, plan, {
    mode: input.mode ?? "remove", max: input.max ?? PROFILE_TIDY_MAX_PER_PASS, log,
  });
}

// ── WRITE ───────────────────────────────────────────────────────────────────────────────────

export interface WriteProfileInput {
  io: ProfileIo;
  doc: OrganizerProfileDoc;
  /** Who is writing — recorded in the message header so the writer recognises its own copy. */
  installId: string;
  /**
   * Payload fingerprints of FOREIGN documents the caller has already accounted for — its own
   * last-written/seeded fingerprint, and any foreign document it has surfaced. A readable
   * foreign document whose fingerprint is on this list is replaceable; one that is NOT is new
   * information, and the write is refused as `foreign` so the caller can surface it first.
   */
  replaceable?: readonly string[];
  /**
   * The record held for an unanswered found-settings question. This write publishes BESIDE it:
   * it neither refuses the write as `foreign` nor is removed by it or by the gate's tidy.
   */
  retain?: ProfileLocator;
  /** `count`: the gate is off and only the replaced document is removed. Default `remove`. */
  tidyMode?: ProfileTidyMode;
  now?: Date;
  log?: ProfileLog;
}

export type WriteProfileResult =
  /** `owed`: the replaced document could not be removed; the caller owes a tidy. */
  | { written: true; removed: number; owed?: true }
  /** The folder holds a document from a NEWER format. Refused — see the versioning rules. */
  | { written: false; reason: "newer"; v: number }
  /**
   * The folder holds a readable FOREIGN document the caller has not seen. Refused, and the
   * document is handed back so the caller can surface it before superseding it on a later write.
   */
  | { written: false; reason: "foreign"; doc: OrganizerProfileDoc; installId: string | null }
  /** Superseded copies are in the folder: one tidy pass ran instead of the append. */
  | { written: false; reason: "cleanup_owed"; removed: number }
  /** The new copy did not read back as written: it was removed and the current one kept. */
  | { written: false; reason: "append_unreadable" };

/**
 * WRITE THE CURRENT PROFILE, and the folder never holds more than two settings messages.
 *
 * List the whole folder; refuse `newer` and an unseen foreign current document; if anything beside
 * the current document C is removable, run one tidy pass INSTEAD of appending (the gate: on a server
 * whose removals do not stick, the pile cannot grow). Then append N, read it back by body and
 * compare fingerprints, and only then remove C. An N that does not read back costs N, never C.
 */
export async function writeOrganizerProfile(input: WriteProfileInput): Promise<WriteProfileResult> {
  const { io, doc, installId } = input;
  const log = input.log ?? ((): void => undefined);
  const mode = input.tidyMode ?? "remove";
  const now = input.now ?? new Date();
  try {
    await io.ensureMetaFolder();
  } catch (err) {
    throw new ProfileUnavailableError(
      `the meta folder ${META_FOLDER} could not be created, so this mailbox's settings cannot travel`,
      { op: "ensure_meta", cause: err },
    );
  }
  let listing: ProfileListing;
  try {
    // COMPLETE: both refusals below are made from this list, and so is the gate.
    listing = await listingOf(io, retainingList(input.retain, { complete: true }));
  } catch (err) {
    throw new ProfileUnavailableError(
      `the organizer profile in ${META_FOLDER} could not be read before writing`,
      { op: "list_profiles", cause: err, code: askCodeOf(err) },
    );
  }
  const { messages } = listing;
  const view = viewOf(messages);
  if (view.newerV !== null) return { written: false, reason: "newer", v: view.newerV };

  // ── AN UNSEEN FOREIGN CURRENT DOCUMENT REFUSES THE WRITE — see the result member ────────────
  const known = new Set(input.replaceable ?? []);
  const docFingerprint = profileFingerprint(doc);
  const held = locatedIn(view, input.retain);
  // The held record is the question the caller is asking, never a document it has not seen.
  const newest = view.current === null || view.current === held ? null : view.current.record as ParsedProfileMessage;
  const unseen = [newest].find((r): r is ParsedProfileMessage => {
    if (r === null) return false;
    if (r.installId === installId) return false;
    // HAVE I SEEN THIS DOCUMENT — asked at the document's OWN version, the identity the caller stored.
    if (known.has(profileFingerprint(r.doc!))) return false;
    // IS IT THE SAME CONFIGURATION — asked at ONE version, so a v1 twin is not a conflict.
    return profileFingerprint(r.doc!, doc.v) !== docFingerprint;
  });
  if (unseen) return { written: false, reason: "foreign", doc: unseen.doc!, installId: unseen.installId };

  // ── THE GATE: anything removable beside C is tidied first, and nothing is appended ─────────
  const claims = listing.claims;
  if (mode === "remove") {
    // The `unseen` refusal above cleared the newest: it is this writer's, held, seen or the same.
    const plan = planTidy(view, installId, now, claims, input.retain, [],
      new Set([...known, ...(newest === null ? [] : [profileFingerprint(newest.doc!)])]));
    if (plan.refs.length > 0) {
      log("profile_write_held_for_cleanup", { removable: plan.refs.length });
      const pass = await tidyPass(io, view, plan, { mode, max: PROFILE_TIDY_MAX_PER_PASS, log });
      return { written: false, reason: "cleanup_owed", removed: pass.removed };
    }
  }

  const refKey = (ref: unknown): string => JSON.stringify(ref ?? null);
  const before = new Set(messages.map((m) => refKey(m.ref)));
  const second = Math.floor(Date.parse(doc.updatedAt) / 1000);
  const isOurs = (headerBlock: string): boolean => {
    const s = shapeOf(headerBlock);
    return s.installId === installId && s.dateSecond === second;
  };
  try {
    await io.appendProfile(formatProfileMessage(doc, { installId }));
  } catch (err) {
    throw new ProfileUnavailableError(
      `the organizer profile in ${META_FOLDER} could not be written`,
      { op: "append_profile", cause: err },
    );
  }

  // ── READ N BACK: a new message of ours with N's Date, read by body, saying what N says ──────
  let back: RawProfileMessage[];
  try {
    back = (await listingOf(io, {
      complete: true, bodyFor: (row) => !before.has(refKey(row.ref)) && isOurs(row.headerBlock),
    })).messages;
  } catch (err) {
    throw new ProfileUnavailableError(
      `the organizer profile in ${META_FOLDER} was written and could not be read back`,
      { op: "list_profiles", cause: err, code: askCodeOf(err) },
    );
  }
  const appended = back.filter((m) => !before.has(refKey(m.ref)) && isOurs(m.headerOnly === true ? m.raw : headerBlockOf(m.raw)));
  const readsBack = (m: RawProfileMessage): boolean => {
    const r = m.headerOnly === true ? null : parseProfileMessage(m.raw, m.ref);
    return r !== null && !isMalformedProfile(r) && r.status === "ok" && profileFingerprint(r.doc!) === docFingerprint;
  };
  const landed = appended.find(readsBack);
  if (landed === undefined) {
    if (appended.length > 0) {
      try {
        await io.removeProfiles(appended.map((m) => m.ref));
      } catch (err) {
        log("profile_cleanup_failed", {
          op: "remove_profiles" satisfies ProfileOp,
          err,
        });
      }
    }
    log("profile_append_unreadable", { count: appended.length });
    return { written: false, reason: "append_unreadable" };
  }

  // ── THEN THE C THIS WRITE REPLACED, and nothing else — never the held record ─────────────────
  const C = view.current !== null && view.current === held ? ownNewest(view, installId) : view.current;
  if (C === null || C.msg.ref === undefined) return { written: true, removed: 0 };
  try {
    /* C's uid is a fact only under the numbering it was LISTED under. The read-back re-listed the
       folder, so the io's own guard now holds the new generation; a renumber in between is caught
       here, by the two listings' generations, or C's uid would name whatever holds it now. */
    if (typeof C.msg.ref === "number" && uidRefsAtEpoch(
      [{ epoch: epochOf(C.msg.generation), uid: C.msg.ref }], epochOf(landed.generation),
    ) === "stale") {
      throw new ProfileUnavailableError(
        `${META_FOLDER} was renumbered between the listing and the read-back, so the replaced `
        + "settings message was not removed",
        { op: "remove_profiles" },
      );
    }
    await io.removeProfiles([C.msg.ref]);
    return { written: true, removed: 1 };
  } catch (err) {
    /* Harmless for readers, and deliberately NOT a throw: the new document IS in the folder.
       The caller owes a tidy, and until one sticks the gate holds every later write. */
    log("profile_cleanup_failed", {
      op: "remove_profiles" satisfies ProfileOp,
      err,
    });
    return { written: true, removed: 0, owed: true };
  }
}
