import type { Destination } from "./types.js";
import type { ClassifierInput, ClassifierPort, ClassifierResult } from "./classifier-port.js";
import { redactForModel, screenOutboundText, type OutboundScreen } from "./sensitive.js";

/**
 * THE ROUTING QUESTION — what is asked, what is refused, and how an answer is made safe.
 *
 * `classifier-port.ts` next door declares the SEAM: three interfaces, so a pipeline can say it
 * may consult a model without depending on one. This file is the QUESTION, and it is deliberately
 * a third thing rather than part of either:
 *
 *  · The port carries no prompt, so code that merely names the seam carries no taxonomy.
 *  · The implementations under `ai/` carry a model id, a request shape and a vendor client.
 *  · What sits between them — the taxonomy itself, the response schema, the outbound sensitivity
 *    sink and the coercion of whatever comes back — belongs to NEITHER, because it is the same
 *    for every implementation and must stay the same for every implementation.
 *
 * That last point is the reason this file exists at all. There is more than one way to reach a
 * model now: a hosted deployment with its own account, and a standalone install running against a
 * key or a local model belonging to the person using it. Two copies of the taxonomy is how those
 * two come to file the same message into different folders — a defect nobody would see in a test,
 * because each copy passes its own. One question, asked identically, however the request travels.
 *
 * It names no model and imports only mail vocabulary, so it is mail-half code: a consumer can ask
 * the routing question and still cannot construct a client to ask it with.
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

/* ── THE SCREENING QUESTION ───────────────────────────────────────────────────────────────────
 *
 * A SECOND question, for the Screener's suggestion path only. Live mail keeps asking the routing
 * question above, unchanged.
 *
 * ## Why a second question rather than a second copy of the first
 *
 * The docblock at the top of this file argues for ONE question asked identically however the
 * request travels. That invariant is about one question per PURPOSE — two copies of the SAME
 * taxonomy is how two hosts file the same message differently — and it is preserved here: this
 * question is defined once, in this file, beside the one it is not.
 *
 * ## The tautology it replaces
 *
 * The Screener's suggestion path used to ask the routing question of mail that is already sitting
 * in `ohmail/Screener`. But `ohmail/Screener` is what the routing taxonomy DEFINES as the correct
 * answer for a first-contact sender, and every row the Screener reasons about is a first-contact
 * sender. So the model was being asked a question whose own rules made one answer correct in
 * advance, and it gave that answer: measured before this change, with no stated bar, nearly nine
 * in ten stored
 * suggestions came back `ohmail/Screener`. The user had paid for advice and been told, at
 * high confidence, that the mail was where it already was.
 *
 * The fix is not a better prompt for the same question. It is a different question: the user is
 * not asking "where does this belong in a mailbox that has a gate" — they are standing AT the
 * gate, and the decision in front of them is what to do with this stranger. So `ohmail/Screener`
 * is removed from the answer set. It is the question being asked; it cannot also be an answer.
 *
 * ## The user's words are BINDING here, not advisory
 *
 * On the routing path the account's bar is one input among several and is explicitly forbidden
 * from carrying a first-contact sender past the gate. Here the bar is the whole point: the person
 * wrote down who they want to hear from, and this question is "does this sender meet what they
 * wrote". The instruction below therefore names the bar as the criteria to judge against rather
 * than something to weigh.
 *
 * **The words themselves still travel in the USER turn, never in this prefix.** The prefix is sent
 * with `cache_control:{type:"ephemeral"}` and that cache is shared across accounts, so one
 * account's sentence embedded here would be served to another's request. What this constant may
 * contain is the INSTRUCTION about the field; what it may never contain is the field's value.
 */
export const SCREEN_DESTINATIONS: Destination[] = [
  "INBOX",
  "ohmail/Reads",
  "ohmail/Receipts",
  "ohmail/Screened",
  "ohmail/Quarantine",
];

/**
 * The screening instruction. Cacheable and account-independent, exactly like
 * {@link TAXONOMY_PREFIX}.
 *
 * Each outcome carries its own criteria, and several are written the way they are because of what
 * was measured without them:
 *
 *  · **Receipts** had to be named with a concrete first-contact example. An order confirmation from
 *    a shop the user has never mailed is the canonical case, and it is the one a "do I know this
 *    sender" reading gets wrong.
 *  · **Quarantine** had to be given criteria that separate junk from mere automation. Left
 *    undefined, "spam" collapses into "automated", and every newsletter becomes spam — or, as
 *    actually happened, nothing does.
 *
 * ── THE OHBOX BAR WAS RAISED, 2026-08-08, AND THIS IS WHY ────────────────────────────────────
 *
 * The version before this one defined INBOX as "a real person writing to them, **or service mail
 * they personally have to act on — a delivery, a security alert, something with a consequence if
 * ignored**". That second clause turned out to admit essentially all of it, and the evidence is
 * the model's own rationales on a live account: of 14 senders it put in the Ohbox, **9 were
 * automated notifications**, and each rationale cited the clause by name — "a service notification
 * with a consequence if ignored", "matching your criteria for real service emails needing a
 * reply". An expired card on a storage subscription and a "your storage is 70% full" warning both
 * landed in the Ohbox at 0.92 confidence.
 *
 * The clause is not repairable by tightening its adjectives, because "has a consequence if
 * ignored" is true of every notification any platform sends — that is what a notification IS. The
 * owner's ruling is the categorical one: automated service mail is NEVER the Ohbox, whatever the
 * consequence; a payment problem is Reads at most. So the criterion is now WHO WROTE IT rather
 * than how bad it sounds, which is a question about the mail that has an answer.
 *
 * Two smaller calibrations land with it, both from named cases:
 *
 *  · **Bulk marketing nobody asked for may be Quarantine.** The old text forbade it outright
 *    ("Being automated, promotional or unwanted is NOT enough"). That sentence was written against
 *    the failure where every newsletter becomes spam, and it overshot: a product newsletter
 *    arriving at an address that never subscribed to it is, to the person receiving it, junk. The
 *    guard against the original failure is now the RELATIONSHIP test rather than a prohibition.
 *  · **A venue's own marketing is Screened, not Reads.** A hotel, restaurant or resort mailing
 *    "we miss you" to a past guest is a business selling to someone who is not currently their
 *    customer. It reads as service mail because the sender is a place the person has been.
 *
 * These are written as CRITERIA, deliberately. Four remembered examples would classify four
 * senders and generalise to nothing; the Screener has 1,698 of them.
 *
 * ── THE SCREENED/QUARANTINE BOUNDARY IS THE RELATIONSHIP, NOT THE BUSINESS ───────────────────
 *
 * Adopted 2026-08-08, and it OVERTURNS a specific piece of reasoning rather than a folder.
 *
 * The two bullets used to contradict each other. `ohmail/Screened` claimed "cold sales
 * approaches, unrequested promotions" by name and imperatively; `ohmail/Quarantine` claimed the
 * same mail conditionally — "Quarantine is available" — behind a relationship test. A model
 * resolving that contradiction takes the imperative branch, and it did: on a live account, cold
 * business-development outreach came back `ohmail/Screened` at 0.95 reasoning, in as many words,
 * *"it's legitimate business mail, just unwanted"*, and a travel site's promotional blast came
 * back `ohmail/Screened` at 0.95 as *"bulk commercial marketing you didn't request"*. The owner's
 * ruling on both was the same word: spam.
 *
 * **The clause overturned is the legitimacy defence.** That a sender is a real, registered,
 * reputable company does not rescue unsolicited commercial contact — legitimacy is not
 * permission. So unsolicited commercial mail (promotional bulk with no prior relationship, cold
 * sales and BD outreach, a newsletter nobody subscribed to) is Quarantine, and `ohmail/Screened`
 * is now GATED on a real prior relationship: a business the person was a customer, guest, client
 * or member of, whose mail is merely unwanted.
 *
 * **The relationship must be evident IN THE MESSAGE, and that is the load-bearing half.** The
 * screening user turn carries `from`, `subject`, a redacted `snippet` and an empty
 * `headersDigest`, with `fewShot: []` — so "did this person ever book with them" is a question
 * the model cannot answer and must not be asked. What it CAN see is whether the mail addresses a
 * named guest or customer, or names a stay, an order, a booking or an account. That is why a
 * hotel writing to a named past guest is Screened while a travel site's generic blast is not,
 * even though both are plausibly places the person has spent money: the burden of proof is on the
 * message. The same operationalisation is applied to Quarantine's "a service the person actually
 * uses" clause, which is otherwise equally unanswerable and would rescue the blast.
 *
 * **"A stranger writing personally is not junk" was QUALIFIED, not deleted.** Deleting it
 * re-opens a measured failure — a tightening of the Quarantine bullet once pulled a real person
 * out of the Ohbox at 0.72 for lacking a relationship, taking the validation set from 17/18 to
 * 15/18. So the clause is qualified by PURPOSE: a stranger writing personally about anything
 * other than selling is still not junk; a stranger writing personally in order to sell is. That
 * is the meetorbitprism case, and it is also why the word "relationship" appears in this prompt
 * only inside clauses about COMMERCIAL mail — let it escape into the INBOX criteria and the model
 * starts demanding a relationship of people, which is precisely what "one human to another,
 * whether or not they have met" exists to prevent.
 *
 * ### What this calibration COST, measured rather than assumed
 *
 * Validated live against the mailbox the ruling came from, 28 senders, before and after. The
 * boundary moved as intended on every case it was aimed at, and two things moved that were not
 * aimed at. Both are recorded here instead of tuned away, because the last attempt to tune a
 * deviation out of this prompt took the set from 17/18 to 15/18 by moving an unrelated boundary.
 *
 *  · **One receipt in three now files to Reads.** A payment confirmation whose subject reads
 *    "We've received your payment for <id>" went from `ohmail/Receipts` 0.99 to `ohmail/Reads`
 *    0.98 and stayed there across four runs; the other two receipts held at 0.95–0.99. The
 *    Receipts bullet is byte-identical, and the model's rationale cites the automated-mail rule
 *    ("it's not from a person, so it belongs in Reads"), not either bullet that changed. So the
 *    cost of stating the junk criteria at this length is that the most notification-shaped
 *    receipt loses its fork. Both outcomes keep it out of the Ohbox and both are durable filings.
 *  · **Promotional mail from a vendor the person pays is now Quarantine, not Screened.** A
 *    conference invitation from an infrastructure provider they actively use came back
 *    `ohmail/Quarantine` 0.92. This one is the ruling working as written rather than a defect:
 *    the message names no account or subscription, so it carries no evidence of the
 *    relationship, and the criteria say the burden of proof is on the message. It is the same
 *    shape as the travel blast the owner called spam. Worth knowing it generalises this far.
 *
 * A third case is unchanged by this calibration and is NOT its doing: a newsletter the person
 * did subscribe to is indistinguishable, from `from`/`subject`/`snippet` alone, from one nobody
 * asked for, and files to Quarantine under both the old prompt and this one. Nothing in the
 * message says "you signed up", so no criteria written against the message can separate them.
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
 * A screening answer, made safe to act on.
 *
 * A label outside {@link SCREEN_DESTINATIONS} becomes `ohmail/Screener`, which every consumer
 * reads as "hold — the person decides". The safe answer does not have to be OFFERED to the model
 * to remain the fallback, and leaving it out of the enum is what removes the tautology.
 *
 * This is also what makes the change degrade safely rather than dangerously: an implementation
 * that has not been taught the screening question and answers the routing taxonomy anyway returns
 * `ohmail/Screener`, which lands here and coerces to a hold. It never coerces to an admission.
 *
 * `spam` is forced to agree with the destination rather than trusted alongside it. The two are one
 * fact in the prompt, and a reply that names `ohmail/Quarantine` with `spam:false` is not a third
 * verdict to preserve — it is the same verdict, said twice, once wrongly.
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
 * SCREEN, THEN BUILD — the last thing that happens to a payload before it is serialised for any
 * model.
 *
 * The pipeline already declines to construct a classifier for sensitive mail on the automatic
 * path, which is what keeps a secret out of the spend ledger as well as off the wire. This is the
 * second line: it re-reads the payload that is about to leave, with the same local detector, and
 * throws. It exists because the first check lives a module away and cannot see a caller that
 * builds its own input — the Screener's explicit suggestion path does exactly that, from a stored
 * row, in a package that cannot see the pipeline.
 *
 * The order is the guarantee. The screen runs before `payload` exists, so there is no moment at
 * which a refused payload has been assembled and something could log it, cache it, or hand it to
 * a retry queue on the way out.
 *
 * ── AND THERE IS NOW A SECOND CALLER SHAPE: `outbound: "prescreened"` ─────────────────────────
 *
 * Under the AI-OPEN rule adopted on 2026-08-08, a caller acting on a person's explicit press
 * redacts the payload itself, with `redactForModel`, and says so on the input. This sink then does
 * not throw.
 *
 * **The redaction is deliberately NOT done here, and that is the correction that matters.** Doing
 * it at this sink would only protect the ONE implementation that happens to route through this
 * function on its way to Anthropic. A `ClassifierPort` is an interface: the sidecar's local
 * Ollama and Anthropic providers implement it, and so could anything else. Those implementations
 * receive `ClassifierInput` DIRECTLY from `ScreenerService`, and a redaction applied downstream of
 * them protects nothing they do. Redacting at the caller means every port — bundled, local or
 * third-party — is handed text with the credential already gone, and this sink's job stays what it
 * always was: to check, not to launder.
 *
 * What it screens and what it deliberately does not: see `screenOutboundText`. Recognised
 * authentication material, an unframed credential shape, and an authentication URL carrying a
 * token are refused. An unsupported script and an unrecognised language are NOT — those are
 * upstream routing decisions, and a sink that threw on every non-Latin payload would break the
 * Screener for non-Latin senders while protecting nothing.
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
 * ── ASK A MODEL ABOUT ONE HELD STRANGER — THE WHOLE REQUEST, IN ONE PLACE ────────────────────
 *
 * Four decisions travel together here, and every one of them is load-bearing. They were written
 * out at the Screener's purchase call site while that was the only caller; there is now a second
 * (the worker's always-on pass for opted-in accounts), and a second COPY of these four lines
 * would be four independent ways to get a money-and-privacy path subtly wrong:
 *
 *  1. **The credential is removed HERE, at the caller, not one layer down.** `ClassifierPort` is
 *     an interface — the bundled client is one implementation, a local Ollama and a
 *     bring-your-own-key provider are others, and they receive this object DIRECTLY. A redaction
 *     applied inside one builder protects exactly that one and leaves a local model reading the
 *     raw code. {@link redactForModel} is conditional (see its docblock): it fires only where the
 *     outbound screen says there is credential material, so ordinary mail is sent verbatim and
 *     not blanked by a detector that matches `NEWSLETTER`.
 *  2. **`outbound: "prescreened"` goes with the redaction and only with it.** It is what stops
 *     {@link classifyUserPayload}'s sink refusing a payload that has already been made safe.
 *     Absent everywhere else, which is what keeps the AUTOMATIC routing path failing closed.
 *  3. **The SCREENING question, not the routing one.** Routing asks "which folder does this
 *     belong in", and `ohmail/Screener` is that taxonomy's own definition of a first-contact
 *     sender — which is every row a caller of this function can have. Asking it there is a
 *     question with its answer built in. The fallback to `classify` exists because a port is
 *     implemented outside this repository too; it degrades the ADVICE and cannot degrade the
 *     safety, since routing's answer for a stranger coerces to a hold, never to an admission.
 *  4. **The bar reaches the model's USER turn, and a blank one is omitted**, so an account that
 *     set none produces a byte-identical request to the pre-bar one.
 *
 * It is not gated on `messages.no_ai`. That column is known-wrong for historical rows, and
 * `subject` is stored RAW even where the body was stored redacted — which is the field a one-time
 * code is usually in. The bytes are always current; the flag is a claim about them.
 *
 * @param classifier the port. The caller decides whether it may spend BEFORE calling this.
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
 * ── THE GATE-CONTRADICTION CHECK ─────────────────────────────────────────────────────────────
 *
 * True when the prose CONCLUDES "hold this at the Screener". It exists because a routing answer
 * has two channels — the structured `destination` and the one-line `rationale` — and only the
 * first is machine-checked. A reply whose rationale reasons its way to the gate while the field
 * names a folder past it is not advice anybody should act on; it is a coin toss with a sentence
 * attached.
 *
 * **The asymmetry is deliberate and it is the whole design.** A false positive here costs a
 * suggestion that reads "this one needs you" — which, for a queue whose every row is a
 * first-contact stranger, is the status quo and costs one human glance. A false negative admits
 * a stranger to the Ohbox and writes them an allow rule. So the check fires on the plain
 * presence of the gate's own name, and buys its narrowness back with a negation guard rather
 * than by hedging: "not a Screener case" and "no Screener hold needed" are the shapes an INBOX
 * verdict actually uses to mention the gate, and they do not fire.
 *
 * `screener` is the one word in this taxonomy with no ordinary mail meaning — nothing else in a
 * rationale is called a screener — which is why this is a keyword check and not a family
 * classifier over all six labels. `reads` is a verb, `inbox` appears in half the sentences a
 * model writes about mail, and a check built on those would fire on prose that agrees with its
 * own field.
 *
 * **It is NOT applied to routing**, and that is a decision rather than an oversight: routing
 * files live mail, and a prose heuristic that moved a message out of somebody's Ohbox would be
 * changing where real mail lands on the strength of a regex. Its one consumer is the Screener's
 * suggestion path, where the only thing it can change is which of three words a chip shows.
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
