import type { Destination } from "./types.js";
import type { ClassifierInput, ClassifierPort, ClassifierResult } from "./classifier-port.js";
import { redactForModel, screenOutboundText, type OutboundScreen } from "./sensitive.js";

/**
 * The routing question — what is asked, what is refused, how an answer is made safe. The port
 * declares the SEAM; the implementations under `ai/` carry a model id and a vendor client; what
 * sits between — the taxonomy, the schema, the outbound sensitivity sink, the coercion — must
 * stay the same for every implementation, which is why this file exists: there is more than one
 * way to reach a model now, and two copies of the taxonomy is how two deployments file the same
 * message into different folders — a defect no test sees, because each copy passes its own. It
 * names no model: a consumer can ask the question and still cannot construct a client.
 */

/**
 * The destinations a routing answer may choose, as a value.
 *
 * Typed as `Destination[]` so that adding a folder to the union without adding it here is a
 * compile error rather than a taxonomy the model is never told about.
 */
export const CLASSIFY_DESTINATIONS: Destination[] = [
  "INBOX",
  "ohmail/Screener",
  "ohmail/Reads",
  "ohmail/Receipts",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/**
 * The FIXED taxonomy/policy/folder-map prefix. It is stable across every classify
 * call so it can be cached (a `system` block with `cache_control:{type:"ephemeral"}`);
 * the volatile per-message fields go in the user turn, after the cache breakpoint.
 */
export const TAXONOMY_PREFIX = [
  "You are the routing classifier for ohmail. Given one email's sender,",
  "subject, a short redacted snippet, and a headers digest, choose exactly one",
  "destination folder from this fixed taxonomy:",
  "",
  "- INBOX: correspondence the owner personally cares about (the Ohbox).",
  "- ohmail/Screener: first-contact senders awaiting owner approval.",
  "- ohmail/Reads: newsletters, marketing, bulk/list mail to skim.",
  "- ohmail/Receipts: receipts, confirmations, statements to keep but not read.",
  "- ohmail/Screened: senders the owner has previously declined.",
  "- ohmail/Quarantine: spam / unsafe mail.",
  "",
  // A GENERIC, CONDITIONAL instruction about the optional per-account field — never the field's
  // value, which is per-account and lives in the user turn (see `ClassifyUserPayload.ohboxBar`).
  // It is inert for the accounts that set no bar (the field is simply absent), so it changes no
  // routing for them, and it deliberately does NOT restate or sharpen the folder definitions
  // above: a base-taxonomy change is its own decision with its own before/after evidence.
  "If the user turn carries an \"ohboxBar\" field, it is the account owner's own statement,",
  "in their words, of who belongs in their Ohbox (INBOX). Weigh it when choosing between INBOX",
  "and the automated piles (Reads/Receipts). It never carries a first-contact sender past the",
  "Screener gate and never changes how sensitive mail is handled.",
  "",
  // ONE CLAUSE, AND IT DECIDES NOTHING ON ITS OWN. `pipeline.ts` already routes a corroborated
  // bounce of the reader's own mail to INBOX before the model is ever consulted (see
  // `rules.ts#dsnVerdict` for why corroboration, not shape, is what earns that). This sentence
  // is for the residue that reaches the model anyway — a report the lookups could not
  // corroborate, or a human-written "your message could not be delivered" that carries no DSN
  // structure at all. It is written as RELEVANCE, in the taxonomy's own vocabulary, because the
  // model's answer is a proposal: it cannot carry a first-contact sender past the Screener, and
  // adding a rule here that tried to would be a prompt overruling the consent gate.
  "A delivery-status report for the reader's own outgoing mail is actionable: it says something",
  "they sent did not arrive, so it belongs in INBOX rather than in the automated piles.",
  "",
  "Return confidence in [0,1], a one-line rationale (never echo secrets/OTP codes),",
  "and whether the message is spam. Respond ONLY with the structured JSON object.",
].join("\n");

/**
 * The screening question — a SECOND question for the Screener's suggestion path only; live mail
 * keeps the routing question. The one-question invariant is per PURPOSE. The tautology it
 * replaces: the suggestion path asked the routing question of mail already in `ohmail/Screener` —
 * which that taxonomy DEFINES as the answer for a first-contact sender; measured, nearly nine in
 * ten suggestions came back `ohmail/Screener`. So the gate is removed from the answer set: it is
 * the question, it cannot also be an answer. The user's bar is BINDING here — and its words
 * travel in the USER turn, never this prefix: the prefix is cached across accounts, so one
 * account's sentence would be served to another's request.
 */
export const SCREEN_DESTINATIONS: Destination[] = [
  "INBOX",
  "ohmail/Reads",
  "ohmail/Receipts",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/**
 * The screening instruction — cacheable, account-independent; each outcome's criteria are written
 * against what was measured without them. The Ohbox bar was raised: "service mail with a
 * consequence if ignored" admitted essentially all of it — automated service mail is never the
 * Ohbox; the criterion is WHO WROTE IT. The Screened/Quarantine boundary is the RELATIONSHIP:
 * legitimacy is not permission — unsolicited commercial mail is Quarantine, and Screened is gated
 * on a prior relationship evident IN THE MESSAGE. "A stranger writing personally is not junk" was
 * qualified by PURPOSE, not deleted. Recorded costs: one receipt in three files to Reads; a
 * paying vendor's promo with no in-message evidence is Quarantine.
 */
export const SCREENING_PREFIX = [
  "You are helping someone screen a first-contact sender for ohmail. This sender is waiting at",
  "the gate: their mail is held, and the person has to decide what happens to it. Your job is to",
  "recommend that decision. Choose exactly one:",
  "",
  "- INBOX: their Ohbox, and the bar for it is high. A REAL PERSON writing to them — one human to",
  "  another, in their own words, whether or not they have met. Also mail about a commitment this",
  "  person made themselves and must personally answer: an appointment, a signature, a reply",
  "  somebody is waiting for.",
  "  AUTOMATED SERVICE MAIL IS NEVER THE OHBOX, however serious it sounds. A failed payment, an",
  "  expiring card, a quota nearly full, a security notice, a platform alert, an \"action required\"",
  "  subject line, an error in a service they run — all of these are notifications generated by a",
  "  system, and they belong in ohmail/Reads. Do not promote one because ignoring it would have a",
  "  consequence: having a consequence is what a notification is for, so that test admits all of",
  "  them. Ask who WROTE it, not how bad it sounds. If the answer is \"a system\", it is not INBOX.",
  "- ohmail/Reads: newsletters, marketing the person signed up for, announcements, bulk or list",
  "  mail worth skimming later — AND every automated notification from a service they use, up to",
  "  and including the urgent-sounding ones. Legitimate mail they may want, but never their Ohbox.",
  "- ohmail/Receipts: order confirmations, invoices, payment and shipping notices, statements,",
  "  booking confirmations. Keep, do not read. A shop the person has never written to still files",
  "  here when the mail is a receipt for something they bought.",
  "- ohmail/Screened: unwanted mail from a business this person has a REAL PRIOR RELATIONSHIP",
  "  with — one they have been a customer, guest, client or member of — still sending them things",
  "  they did not ask for. The relationship has to be VISIBLE IN THIS MESSAGE, because the message",
  "  is all you can see: it addresses them by name as a known customer or guest, or names a past",
  "  stay, a membership or an account of theirs.",
  "  A venue, hotel, restaurant or shop mailing its own promotions and news to a past visitor",
  "  belongs here: being somewhere once is not a subscription, and that mail is the business",
  "  selling rather than serving — but it is a business they dealt with, so it is not junk; just",
  "  unwanted. Automated notification floods they never asked for belong here too.",
  "- ohmail/Quarantine: junk. A forged or deceptive sender, phishing, a message whose purpose is",
  "  to trick the reader — and also UNSOLICITED COMMERCIAL MAIL: promotional bulk sent to someone",
  "  who never asked for it, a newsletter nobody at this address subscribed to, and cold sales or",
  "  business-development outreach from a stranger. That the sender is a real, registered,",
  "  reputable business does not rescue it — legitimacy is not permission.",
  "  The test is the RELATIONSHIP, not the tone: mail from a service the person actually uses —",
  "  shown by this message naming their own account or subscription — is not junk",
  "  however promotional it is, and a stranger writing to them personally about anything other",
  "  than selling is not junk however unwelcome. But a stranger writing personally IN ORDER TO",
  "  SELL is. Where a mailing is bulk, commercial, and unrequested by anyone at this address, it",
  "  is junk.",
  "",
  "Set \"spam\" true only for ohmail/Quarantine, and false for every other destination.",
  "",
  // GENERIC and CONDITIONAL — never the value, which is per-account and lives in the user turn.
  "If the user turn carries an \"ohboxBar\" field, it is this person's own written statement of who",
  "belongs in their Ohbox. Treat it as the binding criteria for this decision: a sender who meets",
  "what it says belongs in INBOX, and a sender it excludes does not, whatever else is true of the",
  "mail. Where it is silent, use the definitions above.",
  "",
  "You are recommending, not filing. Nothing moves until the person agrees, so give the decision",
  "you would defend rather than the safest one. Return confidence in [0,1] and a one-line reason",
  "in plain language, addressed to the person deciding (never echo secrets or one-time codes).",
  "Respond ONLY with the structured JSON object.",
].join("\n");

/** The screening response schema. Same shape as the routing one, over the five-pile answer set. */
export const SCREENING_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["destination", "confidence", "rationale", "spam"],
  properties: {
    destination: { type: "string", enum: SCREEN_DESTINATIONS },
    confidence: { type: "number" },
    rationale: { type: "string" },
    spam: { type: "boolean" },
  },
} as const;

/**
 * A screening answer, made safe to act on. A label outside {@link SCREEN_DESTINATIONS} becomes
 * `ohmail/Screener`, which every consumer reads as "hold — the person decides": the safe answer
 * does not have to be OFFERED to the model to remain the fallback, and leaving it out of the enum
 * is what removes the tautology. This is also what makes the change degrade safely: an
 * implementation that answers the routing taxonomy anyway returns `ohmail/Screener`, which
 * coerces to a hold — never to an admission. `spam` is forced to agree with the destination: a
 * reply naming `ohmail/Quarantine` with `spam:false` is the same verdict said twice, once
 * wrongly.
 */
export function coerceScreeningResult(raw: unknown): ClassifierResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const destination = SCREEN_DESTINATIONS.includes(o.destination as Destination)
    ? (o.destination as Destination)
    : "ohmail/Screener";
  let confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const rationale = typeof o.rationale === "string" ? o.rationale : "";
  return { destination, confidence, rationale, spam: destination === "ohmail/Quarantine" };
}

/**
 * The routing response schema.
 *
 * No numeric min/max — structured-output implementations reject those, and a constraint one
 * endpoint silently drops is not a constraint. `confidence` is clamped in
 * {@link coerceClassifierResult} instead, where it is checked whatever the endpoint did.
 */
export const CLASSIFY_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["destination", "confidence", "rationale", "spam"],
  properties: {
    destination: { type: "string", enum: CLASSIFY_DESTINATIONS },
    confidence: { type: "number" },
    rationale: { type: "string" },
    spam: { type: "boolean" },
  },
} as const;

/**
 * The refusal {@link classifyUserPayload} raises instead of sending. A distinct type because it
 * is NOT a model fault: a caller must never treat it as retryable, and a circuit breaker must
 * never count it as an outage. It carries no message content — only which rule fired — so the
 * refusal itself cannot become the leak.
 */
export class SensitivePayloadRefusal extends Error {
  readonly screen: OutboundScreen;
  constructor(screen: OutboundScreen) {
    super(
      `classifier: refusing to send a payload screened as sensitive `
      + `(rule=${screen.reason}${screen.category ? `, category=${screen.category}` : ""}). `
      + `This is the AUTOMATIC path failing CLOSED at the sink: nobody asked for this call, so `
      + `credential material is not sent. A caller acting on a person's explicit press redacts `
      + `with redactForModel and sets outbound:"prescreened".`,
    );
    this.name = "SensitivePayloadRefusal";
    this.screen = screen;
  }
}

/** What one routing request serialises, once it has passed the screen. */
export interface ClassifyUserPayload {
  from: string;
  subject: string;
  snippet: string;
  headersDigest: string;
  fewShot: Array<{ from: string; destination: Destination }>;
  /**
   * The account's own "who belongs in my Ohbox" bar. Present only when the account set one, and it
   * lives HERE — in the volatile user payload, after the cache breakpoint — never in
   * {@link TAXONOMY_PREFIX}: the prefix is cached with `cache_control:{type:"ephemeral"}` and shared
   * across accounts, so a per-account string in it would poison the cache and leak one account's
   * words onto another's request. Absent ⇒ the field is omitted from the serialised turn entirely.
   */
  ohboxBar?: string;
}

/**
 * Screen, then build — the last thing that happens to a payload before it is serialised for any
 * model. The pipeline already declines to construct a classifier for sensitive mail; this second
 * line re-reads the payload about to leave, with the same detector, and throws — the first check
 * cannot see a caller that builds its own input. The order is the guarantee: the screen runs
 * before `payload` exists, so a refused payload is never assembled to be logged or retried. The
 * redaction is deliberately NOT done here: at this sink it would protect only the one
 * implementation routing through it, while ports receive `ClassifierInput` directly — redacting
 * at the caller hands every port text with the credential gone; this sink checks, never launders.
 */
/** One held first-contact sender, as much of them as the screening question reads. */
export interface ScreeningAsk {
  /** The sender's address, already lower-cased by the caller's queue. */
  fromAddress: string;
  /** RAW, as stored. Redacted here — see {@link askScreeningQuestion}. */
  subject: string;
  /** The stored preview. Redacted here for the same reason. */
  snippet: string;
  /** The account's own "who belongs in my Ohbox" words. Absent ⇒ omitted from the request. */
  ohboxBar?: string;
}

/**
 * Ask a model about one held stranger — the whole request in one place, because there are two
 * callers and a second copy would be four ways to get a money-and-privacy path wrong: (1) the
 * credential is removed HERE, at the caller — ports receive this object directly, and {@link
 * redactForModel} fires only where the screen finds credential material; (2) `outbound:
 * "prescreened"` goes with the redaction and only with it; (3) the SCREENING question, not the
 * routing one — the `classify` fallback degrades advice, never safety; (4) the bar reaches the
 * USER turn, a blank one omitted. Not gated on `messages.no_ai`: known-wrong for historical rows,
 * and `subject` is stored raw. The caller decides whether it may spend BEFORE calling this.
 */
export async function askScreeningQuestion(
  classifier: ClassifierPort, ask: ScreeningAsk,
): Promise<ClassifierResult> {
  const safe = redactForModel(ask.subject, ask.snippet);
  const put = classifier.screen?.bind(classifier) ?? classifier.classify.bind(classifier);
  return put({
    from: { name: null, address: ask.fromAddress },
    subject: safe.subject,
    snippet: safe.snippet,
    headersDigest: "",
    fewShot: [],
    outbound: "prescreened" as const,
    ...(ask.ohboxBar ? { ohboxBar: ask.ohboxBar } : {}),
  });
}

export function classifyUserPayload(input: ClassifierInput): ClassifyUserPayload {
  const screen = screenOutboundText(input.subject, input.snippet);
  // `!== "prescreened"`, never `=== "refuse"` — see `ClassifierInput.outbound` for why the
  // polarity is the guard. An absent field takes this branch.
  if (!screen.safe && input.outbound !== "prescreened") throw new SensitivePayloadRefusal(screen);
  // A blank or whitespace-only bar carries no instruction, so it is dropped rather than serialised
  // as an empty field the model would have to reason about. `undefined` ⇒ the key is omitted.
  const bar = input.ohboxBar?.trim();
  return {
    from: input.from.address,
    subject: input.subject,
    snippet: input.snippet,
    headersDigest: input.headersDigest,
    fewShot: input.fewShot ?? [],
    ...(bar ? { ohboxBar: bar } : {}),
  };
}

/**
 * The gate-contradiction check — true when the prose CONCLUDES "hold this at the Screener". Only
 * the structured `destination` is machine-checked; a reply that reasons its way to the gate while
 * the field names a folder past it is a coin toss with a sentence attached. The asymmetry is the
 * design: a false positive costs one human glance; a false negative admits a stranger and writes
 * an allow rule — so it fires on the plain presence of the gate's name, with a negation guard.
 * `screener` is the one word here with no ordinary mail meaning, hence a keyword check. NOT
 * applied to routing: a prose heuristic must not move real mail; its consumer changes which of
 * three words a chip shows.
 */
const GATE_NAMED = /\bscreener\b/i;
/**
 * The gate's name, NEGATED — "not a Screener case", "never past the Screener", "no Screener hold".
 * Bounded at 40 characters and stopped at a clause break so a negation in one sentence cannot
 * cancel the gate named in the next.
 */
const GATE_NEGATED = /\b(?:not|never|beyond|past|outside|no|without)\b[^.;:]{0,40}?\bscreener\b/i;

/** True ⇒ the rationale's own conclusion is "hold at the gate". See the block above. */
export function rationaleHoldsAtGate(rationale: string): boolean {
  if (typeof rationale !== "string") return false;
  if (!GATE_NAMED.test(rationale)) return false;
  return !GATE_NEGATED.test(rationale);
}

/**
 * A model's answer, made safe to act on.
 *
 * A label outside the taxonomy becomes `ohmail/Screener` — the gate, where a person decides —
 * rather than a guess at what was meant. Never auto-filing on a malformed answer is the point:
 * asking costs one click, and filing wrongly costs mail somebody cannot find.
 */
export function coerceClassifierResult(raw: unknown): ClassifierResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const destination = CLASSIFY_DESTINATIONS.includes(o.destination as Destination)
    ? (o.destination as Destination)
    : "ohmail/Screener";
  let confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0;
  confidence = Math.max(0, Math.min(1, confidence));
  const rationale = typeof o.rationale === "string" ? o.rationale : "";
  const spam = o.spam === true;
  return { destination, confidence, rationale, spam };
}
