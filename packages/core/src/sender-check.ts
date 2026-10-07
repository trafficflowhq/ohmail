import { DESTINATIONS, isConsentingDestination, type Destination } from "./types.js";
import { BRANDS, type Brand } from "./brands.js";
import { foldForMatch, INVISIBLE, SOFT_HYPHEN } from "./text-fold.js";
import { isSharedProviderDomain } from "./rule-order.js";

/**
 * WHO IS THIS MAIL REALLY FROM — a deterministic check that runs BEFORE the model and bounds what
 * its answer may say. The screening prompt names "a forged or deceptive sender, phishing" while
 * every field of the request was written by the sender, so the model was asked to spot forgery
 * with the evidence withheld: two first-time senders at unrelated domains, one "your domain
 * expires in 2 days" subject, both suggested `ohmail/Reads` at 0.95. This computes the facts
 * nobody outside can write — the sending domain against the brand the mail claims, the same
 * subject from strangers, the authentication verdict — hands them to the model as facts, and caps
 * the answer where they decide. Pure: no clock, no store, no network, no node builtin.
 */

/** Which fact decided a capped suggestion. A closed set — the row renders one sentence per code. */
export type SenderReasonCode =
  | "impersonation" | "campaign" | "auth_fail" | "brand_mismatch" | "correspondent";

/**
 * The offline DKIM verdict, as `messages.auth_verdict` spells it. NULL/absent is PERMISSIVE.
 * NOT `rules.ts#AuthVerdict`, which is routing's four-member evidence vocabulary
 * (`unauthenticated | unavailable | pass | fail`) and demotes only. This is the COLUMN's union:
 * six members, one of which — `fail` — both agree about. Two names because they are two
 * questions, and collapsing them would put an alignment word where routing expects evidence.
 */
export type SenderAuthVerdict =
  | "aligned" | "signed_unaligned" | "unsigned" | "fail" | "temperror" | "unavailable";

/** One held sender's representative message, as much of it as this check reads. */
export interface SenderCheckInput {
  /** The envelope author's address. Lower-cased or not; this file folds case. */
  fromAddress: string;
  /** The display name the sender chose, when one was parsed. */
  fromName?: string | null;
  subject: string;
  snippet: string;
  /** `messages.auth_verdict`. NULL/absent ⇒ permissive — see the column's own docblock. */
  authVerdict?: string | null;
}

/** What the check found. Every field is a FACT about this message, never a decision. */
export interface SenderSignals {
  /** The sender's registrable domain — empty when the address has none to read. */
  senderDomain: string;
  /**
   * The identity fact ({@link claimedIdentity}): the sender's name, or its local part, or the
   * subject's lead-in claims a dictionary brand and the address is not the brand's. Set from the
   * fact and from nothing else, so the gate and this cap can never disagree about one message.
   */
  impersonation?: { brand: string; brandDomains: readonly string[] };
  /**
   * A brand named elsewhere — mid-subject, or in the preview beside urgency — by an address that
   * is not the brand's. Advice only: it bounds an admitting suggestion like `brandMismatch` does.
   */
  brandMention?: { brand: string; brandDomains: readonly string[] };
  /** A brand-shaped claim OUTSIDE the dictionary. A fact for the prompt; never a cap alone. */
  brandMismatch?: { claimed: string };
  /** How many DIFFERENT first-time sender domains carried this same subject in one pass. */
  campaign?: { count: number };
  /** The urgency lexicon fired. A weight for the model, never a cap alone. */
  urgency: boolean;
  /** The authentication verdict, when the column carries one. */
  auth?: SenderAuthVerdict;
  /**
   * This account WROTE to the sender, or their mail answers a message it sent — a fact the
   * caller reads from the mailbox (`correspondent.ts`), never from anything the sender wrote.
   * {@link capSuggestion} refuses a denying answer over it; only a failed authentication, which
   * says this message is not from them, outranks it.
   */
  correspondent?: { sentAt: string };
  /**
 * Set ⇒ {@link capSuggestion} will bound the answer, and this is the sentence the row renders.
 * Only these four values ever leave this module towards a surface or a model — with the brand
 * (ours) and the count (ours) beside them. Nothing the sender wrote travels as a "fact".
 */
  reasonCode?: SenderReasonCode;
}

/**
 * PUBLIC SUFFIXES WITH A LABEL UNDER THEM — enough of the list to read a mail domain, not a
 * browser's. A registrable domain is what "the sender's address is not Metanet's" compares, so
 * `mail.metanet.ch` and `metanet.ch` must be one thing and `x.co.uk` and `y.co.uk` two. The full
 * Public Suffix List is a megabyte and a network fetch; this covers the two-label suffixes mail
 * actually arrives under, and an unlisted one degrades to the last two labels — which merges two
 * strangers at worst, the conservative direction for every signal here.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "net.nz", "org.nz",
  "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.hk", "com.sg", "com.my",
  "co.za", "co.in", "co.il", "co.kr", "co.at",
  "com.pl", "com.ua", "com.es", "gov.in", "nic.in",
]);

/**
 * The registrable domain ("eTLD+1") of a host, lower-cased; `""` when there is nothing to read.
 * `packages/services/src/auth/origins.ts` has a twin for WebAuthn rpIDs — that one answers a
 * question about BROWSER origins and refuses a bare public suffix; this one answers a question
 * about mail senders and never throws. Neither package may import the other's module here.
 */
export function registrableDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h.includes("@") || h.includes(" ")) return "";
  const labels = h.split(".").filter(Boolean);
  if (labels.length < 2) return "";
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/** The registrable domain of an email address. `""` for anything without a readable one. */
export function senderDomainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : registrableDomain(address.slice(at + 1));
}

/**
 * THE SUBJECT AS A CAMPAIGN KEY — lower-cased, digits folded to `#`, punctuation and whitespace
 * folded to single spaces. "Ihre Domain läuft in den nächsten 2 Tagen ab" and the same line with
 * a 3 are one campaign; the digits are the part a sender varies for free. Short keys are refused
 * (`""`): "hi" from two strangers is not a campaign, and folding would make it one.
 */
export function normalizeSubject(subject: string): string {
  const folded = subject
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .trim();
  return folded.length >= 8 ? folded : "";
}

/**
 * THE URGENCY LEXICON, bilingual and deliberately small: the verbs a message uses to make someone
 * act before they think. A weight the model is told about and, with a brand claim it cannot
 * corroborate, the second half of a soft cap — never a cap on its own, because a real invoice
 * that really is overdue uses exactly these words.
 */
const URGENCY = [
  "expire", "expires", "expired", "expiring", "läuft ab", "laeuft ab", "abgelaufen", "ablauf",
  "overdue", "überfällig", "ueberfaellig", "mahnung", "letzte mahnung", "final notice",
  "renew", "renewal", "erneuern", "verlängern", "verlaengern",
  "suspend", "suspended", "gesperrt", "sperrung", "deaktiviert", "deactivated",
  "pay now", "zahlen sie", "jetzt zahlen", "bezahlen", "payment required", "zahlungsaufforderung",
  "verify your", "bestätigen sie", "bestaetigen sie", "action required", "handeln sie",
  "immediately", "sofort", "innerhalb von", "within 24", "last warning", "letzte warnung",
];

/** Generic service words a display name wears; never evidence of a claimed ORGANISATION. */
const GENERIC_NAME_TOKENS = new Set([
  "support", "kundensupport", "kundendienst", "kundenservice", "service", "team", "info",
  "news", "newsletter", "noreply", "no-reply", "mail", "mailer", "admin", "administrator",
  "account", "accounts", "konto", "billing", "invoice", "rechnung", "abrechnung", "buchhaltung",
  "security", "sicherheit", "notification", "notifications", "benachrichtigung", "hilfe", "help",
  "office", "kontakt", "contact", "shop", "store", "sales", "verkauf", "marketing",
]);

/** The service words a short gate needle must stand beside to claim a brand ("UBS Sicherheit"). */
const SERVICE_WORDS: ReadonlySet<string> = new Set([
  ...GENERIC_NAME_TOKENS,
  "paket", "sendung", "lieferung", "zustellung", "versand", "karte", "card", "bank", "zahlung",
  "payment", "login", "anmeldung",
]);

/** Everything this file compares is folded one way — `text-fold.ts#foldForMatch`. */
const fold = foldForMatch;

const isWordChar = (c: string): boolean => c !== "" && /[\p{L}\p{N}]/u.test(c);

/**
 * Every position at which `hay` names `needle` on word boundaries — from EACH hit, so
 * `PostFinanceCard | PostFinance` is read past its first, glued occurrence. `.` and `&` may sit
 * inside a needle; they are boundaries in the hay.
 */
function namedAt(hay: string, needle: string): number[] {
  const at: number[] = [];
  if (needle === "") return at;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    if (!isWordChar(hay[i - 1] ?? "") && !isWordChar(hay[i + needle.length] ?? "")) at.push(i);
  }
  return at;
}

function names(hay: string, needle: string): boolean {
  return namedAt(hay, needle).length > 0;
}

/** A short needle claims only with a service word as the word before or after it. */
function besideServiceWord(hay: string, i: number, needle: string): boolean {
  const before = /([\p{L}\p{N}]+)[^\p{L}\p{N}]*$/u.exec(hay.slice(0, i))?.[1];
  const after = /^[^\p{L}\p{N}]*([\p{L}\p{N}]+)/u.exec(hay.slice(i + needle.length))?.[1];
  return (before !== undefined && SERVICE_WORDS.has(before)) || (after !== undefined && SERVICE_WORDS.has(after));
}

/**
 * Letters and digits only, each kept with the span of the hay it came from, and the swaps a
 * sender makes for a letter folded back: `0 3 5` for `o e s`, `1 l i` as one letter, `rn` as `m`.
 * `Post-Finance`, `P.o.s.t.F.i.n.a.n.c.e`, `P0stFinance`, `PostF1nance`, `PostFlnance`,
 * `MyPostFinance` and `Arnazon` share their skeleton with the needle they imitate.
 */
const SKELETON_SWAPS: Readonly<Record<string, string>> = { "0": "o", "1": "i", "l": "i", "3": "e", "5": "s" };
interface Skeleton { text: string; start: number[]; end: number[] }
function skeletonOf(s: string): Skeleton {
  const kept: Array<{ c: string; start: number; end: number }> = [];
  let at = 0;
  for (const cp of s) {
    if (/[\p{L}\p{N}]/u.test(cp)) kept.push({ c: cp, start: at, end: at + cp.length });
    at += cp.length;
  }
  const out: Skeleton = { text: "", start: [], end: [] };
  const push = (c: string, start: number, end: number): void => {
    out.text += c;
    for (let k = 0; k < c.length; k++) { out.start.push(start); out.end.push(end); }
  };
  for (let k = 0; k < kept.length; k++) {
    const ch = kept[k]!;
    const next = kept[k + 1];
    if (ch.c === "r" && next?.c === "n") { push("m", ch.start, next.end); k++; continue; }
    push(SKELETON_SWAPS[ch.c] ?? ch.c, ch.start, ch.end);
  }
  return out;
}
const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;

/** A gate needle this long is also matched by skeleton, anywhere in the hay. */
const SKELETON_MIN_LETTERS = 6;

interface GatedBrand { brand: Brand; gate: string[]; skeletons: string[]; gateShort: string[] }

/** The rows that count for the fact, their needles folded once. A row without needles is advice. */
const GATED: readonly GatedBrand[] = BRANDS.flatMap((b) => {
  const gate = (b.gate ?? []).map(fold);
  const gateShort = (b.gateShort ?? []).map(fold);
  if (gate.length === 0 && gateShort.length === 0) return [];
  const skeletons = gate.filter((n) => letters(n) >= SKELETON_MIN_LETTERS).map((n) => skeletonOf(n).text);
  return [{ brand: b, gate, skeletons, gateShort }];
});

/** Every span of the hay at which it claims the brand: a needle, its skeleton, a short needle by a service word. */
function claimSpans(hay: string, g: GatedBrand, bare: Skeleton): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const n of g.gate) for (const i of namedAt(hay, n)) spans.push([i, i + n.length]);
  for (const n of g.skeletons) {
    for (let i = bare.text.indexOf(n); i >= 0; i = bare.text.indexOf(n, i + 1)) {
      spans.push([bare.start[i]!, bare.end[i + n.length - 1]!]);
    }
  }
  for (const n of g.gateShort) {
    for (const i of namedAt(hay, n)) if (besideServiceWord(hay, i, n)) spans.push([i, i + n.length]);
  }
  return spans;
}

/** A shared provider owns nothing: anyone can register an address there, whichever row lists it. */
function owns(b: Brand, domain: string): boolean {
  return domain !== "" && b.domains.includes(domain) && !isSharedProviderDomain(domain);
}

/** A claimed identity the sender's address does not back. `via` is where the claim was read. */
export interface IdentityFact {
  brand: string;
  via: "name" | "local_part" | "subject_lead";
}

/** What the fact reads, and nothing else: no Reply-To, no snippet, no body. */
export interface IdentityInput {
  fromName: string | null;
  fromAddress: string;
  subject: string;
}

/**
 * The lead-in a service notification wears, for the FACT: `Brand: …`, `Brand - …` or `Brand | …` in
 * any case, read after NFKC with invisibles removed, past `Re:`/`AW:`/`WG:`/`Fwd:`, leading symbols
 * and an opening quote; or a bracketed tag, `[Brand] …`, which claims only when the brand is all it
 * says beside service words (`[owner/repo]` names a repository, not a sender). A digit after the
 * first letter is admitted so `P0stFinance:` reaches the skeleton. Only the capture is read.
 */
const LEAD_IN_FACT = /^([\p{L}][\p{L}\p{N}&.\- ]{2,30}?)\s*["'\u2019\u201C\u201D\u00BB]?\s*[:|\u2013\u2014-]\s+\S/u;
const REPLY_PREFIX = /^(?:re|aw|wg|fwd?)\s*:\s*/iu;
const LEAD_SYMBOLS = /^[^\p{L}\p{N}[]+/u;
const BRACKET_TAG = /^\[([^\]]{2,40})\]/u;
function leadInOf(subject: string): { text: string; tag: boolean } | undefined {
  let s = subject.normalize("NFKC").replace(INVISIBLE, "").replace(SOFT_HYPHEN, "");
  for (let i = 0; i < 4; i++) {
    const next = s.replace(LEAD_SYMBOLS, "").replace(REPLY_PREFIX, "");
    if (next === s) break;
    s = next;
  }
  const tag = BRACKET_TAG.exec(s)?.[1]?.trim();
  if (tag) return { text: tag, tag: true };
  const lead = LEAD_IN_FACT.exec(s)?.[1]?.trim();
  return lead ? { text: lead, tag: false } : undefined;
}

/** Outside `[start, end)` the hay says nothing but service words: `[PostFinance Sicherheit]`. */
function onlyServiceWordsOutside(hay: string, start: number, end: number): boolean {
  const rest = `${hay.slice(0, start)} ${hay.slice(end)}`.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
  return rest.every((w) => SERVICE_WORDS.has(w));
}

/**
 * THE IDENTITY FACT — the one definition, read by the gate (`rules.ts`), stored on the row
 * (`messages.sender_check`) and capping every suggestion ({@link senderCheckAll}). The claim is
 * read from the display name, the address's local part and the subject's lead-in, each on its
 * own; it holds when the address owns a brand a source names and no brand the address does own
 * overlaps that match ("Migros Bank" at migrosbank.ch). A relay's own brand beside a user-chosen
 * name ("PostFinance (via Google Drive)") excuses nothing. First claim wins. Pure.
 */
export function claimedIdentity(input: IdentityInput): IdentityFact | undefined {
  const sources: Array<{ via: IdentityFact["via"]; hay: string; tag: boolean }> = [];
  const name = input.fromName === null ? "" : fold(input.fromName);
  if (/[\p{L}\p{N}]/u.test(name)) sources.push({ via: "name", hay: name, tag: false });
  const at = input.fromAddress.lastIndexOf("@");
  const local = fold(at < 0 ? input.fromAddress : input.fromAddress.slice(0, at));
  if (local !== "") sources.push({ via: "local_part", hay: local, tag: false });
  const lead = leadInOf(input.subject);
  if (lead !== undefined) sources.push({ via: "subject_lead", hay: fold(lead.text), tag: lead.tag });

  const domain = senderDomainOf(input.fromAddress);
  for (const { via, hay, tag } of sources) {
    const bare = skeletonOf(hay);
    const hits = GATED.flatMap((g) => claimSpans(hay, g, bare)
      .filter(([s, e]) => !tag || onlyServiceWordsOutside(hay, s, e))
      .map(([s, e]) => ({ brand: g.brand, s, e })));
    const owned = hits.filter((h) => owns(h.brand, domain));
    const claim = hits.find((h) => !owns(h.brand, domain) && !owned.some((o) => o.s < h.e && h.s < o.e));
    if (claim) return { brand: claim.brand.name, via };
  }
  return undefined;
}

/** A stored row as the passes hold it: the fact's inputs and the column the ingest wrote. */
export interface IdentityRow extends IdentityInput {
  senderCheck: string | null;
  senderCheckBrand: string | null;
}

/**
 * The fact for a stored row: the column when it was checked, the function when it never was —
 * so no window exists in which an unchecked row reads as "nothing found". A value outside the
 * closed set reads as unchecked.
 */
export function identityOfRow(row: IdentityRow): IdentityFact | null {
  if (row.senderCheck === "none") return null;
  const fresh = claimedIdentity(row) ?? null;
  if (row.senderCheck !== "impersonation") return fresh;
  return { brand: row.senderCheckBrand || fresh?.brand || "", via: fresh?.via ?? "name" };
}

/** Where a brand's name was found outside the fact. The subject claims; a snippet mentions. */
type Claim = "strong" | "mention";

/**
 * A BRAND NAMED OUTSIDE THE FACT'S SOURCES — anywhere in the name or the whole subject, or in the
 * preview's first 300 characters. Advice for the suggestion and the prompt, never a hold. First
 * match wins; the dictionary is ordered by sector and no message honestly claims two brands.
 */
function mentionedBrand(input: SenderCheckInput): { brand: Brand; claim: Claim } | undefined {
  const strong = fold(`${input.fromName ?? ""} ${input.subject}`);
  const mention = fold(input.snippet.slice(0, 300));
  let weak: Brand | undefined;
  for (const b of BRANDS) {
    const needles = [fold(b.name), ...b.aliases.map(fold)];
    if (needles.some((n) => names(strong, n))) return { brand: b, claim: "strong" };
    if (weak === undefined && needles.some((n) => names(mention, n))) weak = b;
  }
  return weak ? { brand: weak, claim: "mention" } : undefined;
}

/**
 * A BRAND-SHAPED CLAIM THE DICTIONARY DOES NOT HOLD — the `"<Name>: …"` / `"<Name> - …"` lead-in a
 * service notification wears. Bounded hard on purpose: a capitalized word in a subject is most of
 * all mail, so this reads only the LEAD-IN position, skips the generic service words, and skips
 * anything the sender's own domain already carries. It caps nothing by itself — it is a fact for
 * the prompt, and half of a soft cap.
 */
/** The `"<Name>: ..."` / `"<Name> - ..."` lead-in a service notification wears. */
const LEAD_IN = /^\s*([\p{Lu}][\p{L}&.\- ]{2,30}?)\s*[:\u2013\u2014-]\s+\S/u;

function claimedOrgToken(input: SenderCheckInput, domain: string): string | undefined {
  const bare = domain.replace(/[^a-z0-9]/g, "");
  // THE SUBJECT'S LEAD-IN AND NOTHING ELSE. A display name was read here too and it read every
  // PERSON as an organisation — "Anna Brunner" at a domain that is not "brunner" is most personal
  // mail there is, and a fact stated about all of it is noise in every prompt. A "<Name>: ..."
  // lead-in is a sender asserting WHO IS WRITING; a display name is just a name.
  const lead = LEAD_IN.exec(input.subject);
  const claim = lead?.[1]?.trim();
  if (!claim) return undefined;
  for (const raw of claim.split(/[^\p{L}\p{N}]+/u)) {
    const t = raw.toLowerCase();
    if (t.length < 4 || GENERIC_NAME_TOKENS.has(t)) continue;
    if (bare.includes(t.replace(/[^a-z0-9]/g, ""))) return undefined;
    return claim;
  }
  return undefined;
}

/** The authentication verdict, read as the column's own union. Anything else is absent. */
function authOf(raw: string | null | undefined): SenderAuthVerdict | undefined {
  const v = (raw ?? "").trim();
  return v === "aligned" || v === "signed_unaligned" || v === "unsigned"
    || v === "fail" || v === "temperror" || v === "unavailable"
    ? v
    : undefined;
}

/**
 * THE CHECK, over a whole pass at once — `campaign` is the only signal that cannot be computed
 * from one message, and computing it needs the set the pass is about to ask about. Returns one
 * `SenderSignals` per input, in order. Two senders at the SAME registrable domain are one sender
 * for this purpose: a campaign is strangers, not a mailing list sending twice.
 */
export function senderCheckAll(inputs: readonly SenderCheckInput[]): SenderSignals[] {
  const domainsBySubject = new Map<string, Set<string>>();
  const domains = inputs.map((i) => senderDomainOf(i.fromAddress));
  inputs.forEach((i, n) => {
    const key = normalizeSubject(i.subject);
    const d = domains[n] ?? "";
    if (!key || !d) return;
    const set = domainsBySubject.get(key) ?? new Set<string>();
    set.add(d);
    domainsBySubject.set(key, set);
  });

  return inputs.map((input, n) => {
    const senderDomain = domains[n] ?? "";
    const out: SenderSignals = { senderDomain, urgency: false };

    const auth = authOf(input.authVerdict);
    if (auth) out.auth = auth;

    const text = fold(`${input.subject} ${input.snippet.slice(0, 300)}`);
    out.urgency = URGENCY.some((w) => text.includes(w));

    const key = normalizeSubject(input.subject);
    const count = key ? domainsBySubject.get(key)?.size ?? 0 : 0;
    if (count >= 2) out.campaign = { count };

    // THE CLAIM AGAINST THE ADDRESS: the identity fact, and nothing else, decides `impersonation`.
    const fact = claimedIdentity({
      fromName: input.fromName ?? null, fromAddress: input.fromAddress, subject: input.subject,
    });
    const factBrand = fact ? BRANDS.find((b) => b.name === fact.brand) : undefined;
    if (factBrand) {
      out.impersonation = { brand: factBrand.name, brandDomains: factBrand.domains };
    } else if (senderDomain) {
      // A snippet MENTION counts only with urgency beside it — see `mentionedBrand`.
      const named = mentionedBrand(input);
      if (named && !owns(named.brand, senderDomain) && (named.claim === "strong" || out.urgency)) {
        out.brandMention = { brand: named.brand.name, brandDomains: named.brand.domains };
      }
    }
    if (!out.impersonation && !out.brandMention && senderDomain) {
      const token = claimedOrgToken(input, senderDomain);
      if (token) out.brandMismatch = { claimed: token };
    }

    out.reasonCode = decideReason(out);
    return out;
  });
}

/** The check for ONE message — {@link senderCheckAll} of a set of one, so `campaign` cannot fire. */
export function senderCheck(input: SenderCheckInput): SenderSignals {
  return senderCheckAll([input])[0] as SenderSignals;
}

/**
 * WHICH FACT DECIDES, when more than one fired. Ordered by how much it says about THIS sender:
 * having been written to by this account first (short of a failed authentication), then the
 * forged identity, the sender's own authentication, the crowd, the unverifiable claim. Only
 * those three cap hard; `brand_mismatch` is a brand named outside the fact, or an unmatched
 * lead-in with urgency beside it, checked here so `capSuggestion` and the rendered reason can
 * never disagree.
 */
function decideReason(s: SenderSignals): SenderReasonCode | undefined {
  if (s.correspondent && s.auth !== "fail") return "correspondent";
  if (s.impersonation) return "impersonation";
  if (s.auth === "fail") return "auth_fail";
  if (s.campaign && s.campaign.count >= 2) return "campaign";
  if (s.brandMention || (s.brandMismatch && s.urgency)) return "brand_mismatch";
  return undefined;
}

/** A suggestion as this file reads and returns one — the four stored fields plus the reason. */
export interface CheckedSuggestion {
  destination: Destination;
  confidence: number;
  rationale: string;
  spam: boolean;
  reasonCode?: SenderReasonCode;
}

/** The floor a capped suggestion is stated at — never below what the model itself said. */
export const CAP_CONFIDENCE = 0.9;
/** The ceiling a soft signal leaves on an ADMITTING pile: below any surface's "believe this". */
export const SOFT_CEILING = 0.5;
/** The piles a soft cap bounds — the three that carry mail towards the reader. */
const ADMITTING: readonly Destination[] = DESTINATIONS.filter(isConsentingDestination);

/**
 * THE FACTS CAP THE ANSWER. A forged sender, one subject from a crowd of strangers, or a failed
 * authentication is a verdict the model does not get to overrule: the suggestion becomes
 * `ohmail/Quarantine` at {@link CAP_CONFIDENCE} or the model's own higher number, and the model's
 * sentence is kept only where it AGREED — a rationale explaining why this is a friendly service
 * notice must not be printed under a spam verdict. A soft claim with urgency beside it only bounds
 * how sure an admitting pile may sound. NO SIGNAL RETURNS THE ANSWER UNTOUCHED, field for field,
 * including the absence of `reasonCode`: today's behaviour for every ordinary sender.
 */
export function capSuggestion(model: CheckedSuggestion, s: SenderSignals): CheckedSuggestion {
  // The signal is read, not the stored code: a caller that attaches the fact after the check ran
  // is still bounded, and a correspondent is re-decided whatever code the check computed.
  const reason = s.correspondent && s.auth !== "fail" ? "correspondent" : s.reasonCode;
  if (reason === undefined) return model;
  /* SOMEBODY THIS ACCOUNT WROTE TO IS NOT SPAM, however sure the model sounded. An admitting
     answer stands with the reason beside it; anything else becomes the Ohbox, and the model's
     sentence goes with it — a rationale arguing spam must not print under an Ohbox verdict. */
  if (reason === "correspondent") {
    if (ADMITTING.includes(model.destination) && !model.spam) return { ...model, reasonCode: reason };
    // The fact's confidence, never the model's: its 1.0 was about spam, not about the Ohbox.
    return { destination: "INBOX", confidence: CAP_CONFIDENCE, rationale: "", spam: false, reasonCode: reason };
  }
  if (reason === "brand_mismatch") {
    if (!ADMITTING.includes(model.destination) || model.confidence <= SOFT_CEILING) {
      return { ...model, reasonCode: reason };
    }
    return { ...model, confidence: SOFT_CEILING, reasonCode: reason };
  }
  const agreed = model.destination === "ohmail/Quarantine";
  return {
    destination: "ohmail/Quarantine",
    confidence: Math.max(model.confidence, CAP_CONFIDENCE),
    rationale: agreed ? model.rationale : "",
    spam: true,
    reasonCode: reason,
  };
}

/**
 * THE FACTS, FOR THE PROMPT — a labelled block the model is told ohmail computed, so it weighs
 * them instead of re-deriving them from the same sender-written text it already has. Returns
 * `undefined` when there is nothing to state, and the request is then byte-for-byte the one it
 * always was. It states facts only: no verdict, no instruction, and nothing about this account.
 */
export function senderFacts(s: SenderSignals): string | undefined {
  // URGENCY ALONE STATES NOTHING NEW. It is read off the very subject the model already has, and
  // a block on every mail that says "renew" would change the question for a large share of
  // ordinary mail for no added fact. The block appears only where ohmail checked something the
  // model cannot see; urgency then rides along inside it.
  if (!s.impersonation && !s.brandMention && !s.brandMismatch && !s.campaign && !s.auth && !s.correspondent) {
    return undefined;
  }
  const lines: string[] = [];
  if (s.senderDomain) lines.push(`- the sender's address is at ${s.senderDomain}`);
  if (s.correspondent) lines.push("- this account wrote to this sender, or their mail answers a message it sent");
  const named = s.impersonation ?? s.brandMention;
  if (named) {
    lines.push(`- the mail names ${named.brand}, whose own addresses are at `
      + `${named.brandDomains.join(", ")}`);
  } else if (s.brandMismatch) {
    // THE MISMATCH, NEVER THE SENDER'S OWN WORDS. `claimed` is a fragment of the RAW subject, and
    // the subject the model receives has been through `redactForModel` — quoting it here would
    // carry unredacted sender text past that sink. The model already has the subject; the fact it
    // cannot derive is that nothing in the name matches the address, so that is what is stated.
    lines.push("- the name this mail leads with does not match the sending domain");
  }
  if (s.campaign) {
    lines.push(`- the same subject arrived from ${s.campaign.count} unrelated first-time senders`);
  }
  if (s.urgency) lines.push("- the subject or preview presses for action within a deadline");
  if (s.auth) lines.push(`- authentication of the claimed author: ${s.auth}`);
  return ["Facts ohmail checked — not for you to re-derive:", ...lines].join("\n");
}
