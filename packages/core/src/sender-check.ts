import type { Destination } from "./types.js";
import { BRANDS, type Brand } from "./brands.js";

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
export type SenderReasonCode = "impersonation" | "campaign" | "auth_fail" | "brand_mismatch";

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
  /** `Reply-To`, when the message carried one and it differs from `From`. */
  replyToAddress?: string | null;
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
   * The mail NAMES a brand in the dictionary and comes from an address that is not the brand's.
   * The strongest signal here, and the only one that names a specific company.
   */
  impersonation?: { brand: string; brandDomains: readonly string[] };
  /** A brand-shaped claim OUTSIDE the dictionary. A fact for the prompt; never a cap alone. */
  brandMismatch?: { claimed: string };
  /** How many DIFFERENT first-time sender domains carried this same subject in one pass. */
  campaign?: { count: number };
  /** The urgency lexicon fired. A weight for the model, never a cap alone. */
  urgency: boolean;
  /** The authentication verdict, when the column carries one. */
  auth?: SenderAuthVerdict;
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

/** Everything this file compares is folded the same way: lower case, accents kept, one space. */
function fold(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Does `hay` name `needle` on word boundaries? `.` and `&` are part of brand tokens, not breaks. */
function names(hay: string, needle: string): boolean {
  const i = hay.indexOf(needle);
  if (i < 0) return false;
  const before = i === 0 ? "" : hay[i - 1] ?? "";
  const after = hay[i + needle.length] ?? "";
  const boundary = (c: string): boolean => c === "" || !/[\p{L}\p{N}]/u.test(c);
  return boundary(before) && boundary(after);
}

/** Every token of a brand, as the domain test reads them: letters and digits only, 4+ long. */
function brandTokens(b: Brand): string[] {
  const out: string[] = [];
  for (const a of [b.name, ...b.aliases]) {
    for (const t of fold(a).split(/[^\p{L}\p{N}]+/u)) if (t.length >= 4) out.push(t);
  }
  return out;
}

/** True ⇒ the sender's own domain carries the brand's token, so the claim is not a mismatch. */
function domainCarriesBrand(domain: string, b: Brand): boolean {
  const bare = domain.replace(/[^a-z0-9]/g, "");
  return brandTokens(b).some((t) => bare.includes(t.replace(/[^a-z0-9]/g, "")));
}

/** Where a brand's name was found. The display name and the subject CLAIM; a snippet mentions. */
type Claim = "strong" | "mention";

/**
 * WHICH BRAND THIS MAIL CLAIMS TO BE, and how loudly. The display name and the subject are the
 * sender asserting an identity; the snippet's first 300 characters may simply MENTION a company
 * ("I switched to Swisscom last year"), which is why a mention alone is not impersonation — it is
 * promoted only when the urgency lexicon fires beside it. First match wins; the dictionary is
 * ordered by sector and no message honestly claims two brands.
 */
function claimedBrand(input: SenderCheckInput): { brand: Brand; claim: Claim } | undefined {
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

    // THE CLAIM AGAINST THE ADDRESS. `Reply-To` is read beside `From` because a forged mail often
    // signs its reply path with the domain that actually collects the answer: a claim is a
    // mismatch only when NEITHER address belongs to the brand. A sender domain carrying the
    // brand's own token is not a mismatch either — `swisscom-billing.example` is someone else's
    // problem to judge, and this check refuses to call it forgery.
    const replyDomain = input.replyToAddress ? senderDomainOf(input.replyToAddress) : "";
    const claimed = claimedBrand(input);
    if (claimed && senderDomain) {
      const b = claimed.brand;
      const owns = (d: string): boolean => d !== "" && b.domains.includes(d);
      const mismatch = !owns(senderDomain) && !owns(replyDomain)
        && !domainCarriesBrand(senderDomain, b)
        && !(replyDomain !== "" && domainCarriesBrand(replyDomain, b));
      // A snippet MENTION is promoted to a claim only with urgency beside it — see `claimedBrand`.
      if (mismatch && (claimed.claim === "strong" || out.urgency)) {
        out.impersonation = { brand: b.name, brandDomains: b.domains };
      }
    }
    if (!out.impersonation && senderDomain) {
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
 * the forged identity first, then the sender's own authentication, then the crowd, then the
 * unverifiable claim. Only the first three cap hard; `brand_mismatch` needs urgency beside it,
 * which is checked here so `capSuggestion` and the rendered reason can never disagree.
 */
function decideReason(s: SenderSignals): SenderReasonCode | undefined {
  if (s.impersonation) return "impersonation";
  if (s.auth === "fail") return "auth_fail";
  if (s.campaign && s.campaign.count >= 2) return "campaign";
  if (s.brandMismatch && s.urgency) return "brand_mismatch";
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
const ADMITTING: readonly Destination[] = ["INBOX", "ohmail/News", "ohmail/Receipts"];

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
  const reason = s.reasonCode;
  if (reason === undefined) return model;
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
  if (!s.impersonation && !s.brandMismatch && !s.campaign && !s.auth) return undefined;
  const lines: string[] = [];
  if (s.senderDomain) lines.push(`- the sender's address is at ${s.senderDomain}`);
  if (s.impersonation) {
    lines.push(`- the mail names ${s.impersonation.brand}, whose own addresses are at `
      + `${s.impersonation.brandDomains.join(", ")}`);
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
