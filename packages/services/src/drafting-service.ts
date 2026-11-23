import { and, asc, eq, isNull, ne } from "drizzle-orm";
import {
  messages, draftAttemptKey, draftFromTextAttemptKey, modelConsentGate, ModelConsentWithdrawn, readManagedModelConsent, reverseCharge,
  type IdempotencyKey, type ReverseChargeFact, type ReverseChargeResult,
} from "@trafficflow/db";
// TYPE-ONLY, and it has to stay that way: `import type` is erased, so it creates no module edge
// into the hosted half. A value import from `/cloud` here would put billing and the ledger into
// the desktop engine, which mounts this service.
/* The PORT, from the root barrel — not `@trafficflow/db/cloud`, which is the half that
 * answers. This service names a gate it may be handed; it never builds one, and it must
 * compile in a deployment where no gate and no ledger exist. */
import type {
  AccessPort, AiUsageHost, RefundObligationPort, SpendPort,
} from "@trafficflow/db";
import {
  createLogger, plainTextToOutboundBody, screenModelInput, MODEL_SINK_REFUSAL_SENTENCE, ModelDeclinedError, NO_LETTER,
  type DraftCallOptions, type DraftInput, type DraftPort, type DraftResult, type ModelSinkReason,
} from "@trafficflow/core/mail";
import type { DraftFromTextBody, UntrustedBody } from "@ohmail/wire";
import { usageLines } from "./ai-usage-lines.js";
import { bridgeTx, type ServiceContext } from "./context.js";
import { IdempotencyRaceLost, ServiceError } from "./errors.js";
import { refuseAiSpend } from "./ai-refusal.js";
import { DraftsService, DRAFT_SUBJECT_MAX_CHARS, type DraftCreateIdempotency } from "./drafts-service.js";
import { claimDraftReceipt, type DraftReceipt } from "./draft-attempt-receipt.js";
import { KbService } from "./kb-service.js";
import { SEARCH_QUERY_MAX_CHARS } from "./search-service.js";

/**
 * How much of the message's SNIPPET the KB retrieval hint may carry.
 *
 * The snippet is cut to 200 characters at ingest, and the hint's whole budget is
 * `SEARCH_QUERY_MAX_CHARS` (200) — so giving the snippet all of it would leave the subject
 * nothing. 120 leaves 79 for the subject after the joining space, which is a whole subject line
 * for most mail and enough of a long one to be the topic.
 */
const KB_HINT_SNIPPET_CHARS = 120;

const log = createLogger({ service: "drafting" });

/** A failed draft's refund facts, as lines naming the account and the attempt — never an address. */
function sayDraftRefund(f: ReverseChargeFact, accountId: string, attempt: string): void {
  if (f.fact === "settle_failed") {
    log.warn("draft_refund_settle_failed", {
      accountId, attempt, err: f.err,
      reason: "the refund settled and its debt could not be marked paid; the drain sends it again "
        + "under the same attempt, which the program reverses once",
    });
    return;
  }
  log.warn("draft_refund_unrecorded", {
    accountId, attempt, ...(f.fact === "unrecorded" ? { err: f.err } : {}),
    reason: f.fact === "unrecorded"
      ? "the refund obligation could not be written; the refund is still tried, and a lost "
        + "release would leave this charge with nothing to reverse it"
      : "a refund is owed and no obligation store was composed beside the gate, so a lost "
        + "release would leave this charge with nothing to reverse it",
  });
}

/**
 * THE LONGEST TEXT A DRAFT FROM THE PERSON'S OWN WORDS TAKES, after trim: a few paragraphs of
 * what a letter should say, never a letter pasted whole. It travels to a model, priced per token.
 */
export const DRAFT_OWN_TEXT_MAX_CHARS = 4_000;

/** The credential door's refusal, said about the person's own text rather than a message. */
const OWN_WORDS_REFUSAL_SENTENCE: Record<ModelSinkReason, string> = {
  vocabulary: "your text reads like an authentication mail",
  credential_shape: "your text contains something that looks like a credential",
  auth_url_token: "your text carries a sign-in link with a token in it",
};

/** An optional id of the body: absent, or a string that is not empty. */
function optionalId(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0) throw new ServiceError("validation_failed", 400, `${field} must be a non-empty string`);
  return v;
}

/** The knowledge-base hint of a letter, as {@link DraftingService.draftFromMessage} budgets it. */
function kbHintOf(target: { subject: string; snippet: string }): string {
  const snippet = target.snippet.slice(0, KB_HINT_SNIPPET_CHARS);
  // The joining space is only spent when there IS a snippet — subtracting it unconditionally took a
  // character off the subject of a message with no snippet at all, for a separator `trim()` removed.
  const subjectRoom = SEARCH_QUERY_MAX_CHARS - snippet.length - (snippet.length > 0 ? 1 : 0);
  return `${target.subject.slice(0, Math.max(0, subjectRoom))} ${snippet}`.trim();
}

/** How many KB entries and thread messages to retrieve as grounding context. */
const DEFAULT_KB_K = 5;
const MAX_THREAD_MESSAGES = 20;

/**
 * THE ADMISSION ARITHMETIC — never charge for a draft that cannot finish inside the invocation.
 * The spend call's own budget (the entitlements client's `ENTITLEMENTS_CALL_BUDGET_MS`, restated
 * because `src` may not name the Cloud barrel; a test pins the two), the least model time a
 * charge may buy, and what is held back after the model for whichever close runs: the refund
 * (the owed row, then one release call) or the draft's store and the response.
 */
export const DRAFT_ADMISSION = {
  spendCallCeilingMs: 5_000,
  minModelMs: 10_000,
  closeReserveMs: 6_000,
} as const;

/**
 * WHAT A DELIVERED DRAFT'S USAGE RELEASE MUST LEAVE AFTER ITSELF before the platform's kill: the
 * fault record a timed-out call writes (the API's `API_FAULT_RECORD_BUDGET_MS`, restated for the
 * reason above; a test in `packages/api` pins the two) and the response itself.
 */
export const DRAFT_USAGE_RELEASE = {
  faultRecordMs: 1_000,
  responseMarginMs: 500,
} as const;

/** When the spend may still start, and when the model call is cut — or `null` where nothing kills a request. */
export function draftWindow(
  invocationBudgetMs: number | undefined, startedAt: number,
  admission: { spendCallCeilingMs: number; minModelMs: number; closeReserveMs: number } = DRAFT_ADMISSION,
): { admitUntil: number; modelDeadline: number } | null {
  if (invocationBudgetMs === undefined) return null;
  const modelDeadline = startedAt + invocationBudgetMs - admission.closeReserveMs;
  return {
    modelDeadline,
    admitUntil: modelDeadline - admission.spendCallCeilingMs - admission.minModelMs,
  };
}

/**
 * The per-call drafting deps: the INJECTED DraftPort (mocked in tests; a real
 * `makeSonnetDrafter(new Anthropic())` in prod) plus retrieval knobs. The port is
 * passed per-call — the service itself holds no live model client.
 */
export interface DraftFromMessageDeps {
  drafter: DraftPort;
  onPreview?: DraftCallOptions["onPreview"];
  /** KB retrieval top-k (default 5). */
  k?: number;
  /**
   * The AI spend gate. Absent ⇒ unmetered (the desktop tier and tests written before
   * metering existed). Present ⇒ {@link DraftFromMessageDeps.attemptKey} is REQUIRED, because a metered AI
   * action must carry the client's own statement of intent.
   */
  credits?: SpendPort;
  /**
   * WHERE A SPEND THAT BOUGHT NOTHING IS REMEMBERED — REQUIRED whenever {@link credits} is, and
   * refused by name when it is not.
   *
   * The sequence this closes: the charge lands, the drafter throws, the reversal is attempted, the
   * entitlements program is unreachable, `release` reports `unreachable` — and without a place to
   * write it down that debt exists nowhere. The person has paid for a draft they never got.
   *
   * REQUIRED rather than optional-and-skipped because the two states are not a caller's choice: a
   * host that meters can always lose a refund, so a metered composition with no memory for one is
   * a wiring fault, and the honest moment to say so is the first paid press rather than the first
   * outage. `spend-port-fake.ts`' twin in the API composes both from one place.
   */
  obligations?: RefundObligationPort;
  /**
   * The managed account's current AI access, checked again before model dispatch.
   * A spend refusal also uses it to distinguish a payment demand from a host fault.
   */
  access?: AccessPort;
  /**
   * The request's `Idempotency-Key`, branded by `clientIdempotencyKey` at the HTTP edge.
   *
   * The idempotency contract is categorical about the provenance and the brand is what enforces
   * it: a key the SERVER mints fresh per invocation turns a client's same-key retry of a
   * LOST RESPONSE into a second charge, whereas the `Idempotency-Key` is exactly the
   * client's "this is one intent" token. A `randomUUID()` cannot be passed here without
   * someone writing `clientIdempotencyKey` and lying about where the value came from.
   */
  attemptKey?: IdempotencyKey;
  /** The HTTP receipt, saved with the draft or with a charged failure after preview. */
  idempotency?: DraftCreateIdempotency;
}

interface DraftWork {
  window: ReturnType<typeof draftWindow>;
  input: DraftInput;
  mailboxId: string;
  meta: Record<string, string>;
  keyOf: () => string;
  store: (result: DraftResult, idempotency?: DraftCreateIdempotency) => Promise<{ draft: { id: string }; seq: number }>;
}

/**
 * DraftingService — the AI draft-from-history flow: assemble a SENSITIVITY-SAFE context, call the
 * injected DraftPort, STORE the result as a `drafts` row (never sent). REFUSAL: a `no_ai` or
 * sensitive TARGET throws 422 `sensitive_no_ai` BEFORE any context is assembled — the target body
 * is never read, the drafter's call-count stays 0. CONTEXT: KB retrieval plus the target thread's
 * OTHER messages as redacted snippets. SENSITIVITY EXCLUSION: carried STRUCTURALLY in the SQL
 * WHERE (`no_kb = false AND no_ai = false AND sensitivity_category IS NULL`) — never a
 * post-filter that could be forgotten. Storing goes through `DraftsService.create`, so the
 * `draft` change row is emitted in-tx and mailbox ownership re-checked.
 */
export class DraftingService {
  constructor(
    private readonly drafts: DraftsService = new DraftsService(),
    private readonly kb: KbService = new KbService(),
    /**
     * THE WALL-CLOCK CEILING THIS HOST KILLS A REQUEST AT — the screener's `invocationBudgetMs`,
     * declared by the composition root and ABSENT for a host that has none (the desktop, a
     * self-hosted server). Present, a charge is taken only with time left to use it, and the model
     * call is cut before the kill so the refund can run. See {@link draftWindow}.
     */
    private readonly opts: {
      invocationBudgetMs?: number;
      /** Test seam: the arithmetic's three numbers. Default {@link DRAFT_ADMISSION}. */
      admission?: typeof DRAFT_ADMISSION | { spendCallCeilingMs: number; minModelMs: number; closeReserveMs: number };
      /**
       * WHICH HOST THIS IS, for the usage line the draft's release carries. Stated by the
       * composition root; ABSENT, no line is made and a delivered draft is released by nobody,
       * as before.
       */
      usageHost?: AiUsageHost;
    } = {},
  ) {}

  async draftFromMessage(
    ctx: ServiceContext,
    messageId: string,
    deps: DraftFromMessageDeps,
  ): Promise<{ draftId: string; seq: number }> {
    // Measured from the TOP with `Date.now()`, not `ctx.now()`: a frozen test clock would switch
    // the window off silently — the screener's `admissionDeadline` rule.
    const window = draftWindow(this.opts.invocationBudgetMs, Date.now(), this.opts.admission);
    // 1. Load the target — account-scoped: a cross-account id is a 404. 2. Refuse a sensitive /
    //    no_ai target BEFORE reading any body or assembling context — the sensitive message never
    //    reaches the model ({@link letterOf}).
    const target = await this.letterOf(ctx, messageId);

    // 3. Assemble the sensitivity-safe context. We use snippets, never bodies.
    //
    //    BEFORE the charge, and that ordering is a fix rather than a preference. Both calls
    //    below are database round-trips and both can fail; charging first meant a KB or thread
    //    retrieval fault billed the customer an AI action for a request in which zero model
    //    calls occurred — a charge the ledger could never explain. Nothing here spends a token,
    //    so nothing here needs to be paid for first.
    /**
     * The retrieval hint is BUDGETED, because one half is sender-chosen and unbounded.
     * `target.snippet` is cut to 200 characters at ingest; `target.subject` is whatever
     * `Subject:` header arrived, capped nowhere. Concatenated then truncated downstream, a long
     * subject consumed the whole retained prefix and silently discarded the snippet — a
     * stranger's header decided which half of the grounding survived. Each half gets its own
     * share, and the shares SUM to the downstream ceiling, stated as a subtraction: whatever the
     * snippet is allowed, the subject gets the rest, and the total is the ceiling exactly.
     */
    const query = kbHintOf(target);
    const kbHits = await this.kb.retrieve(ctx, query, deps.k ?? DEFAULT_KB_K);
    const threadMessages = target.threadId
      ? await this.retrieveThreadContext(ctx, target.threadId, target.id)
      : [];

    /**
     * THE DOOR, before the input object exists and before the charge. Step 2 above refuses a
     * target the INGEST flagged; this refuses a payload whose JOIN carries credential material —
     * the case those per-column flags cannot see, a credential split across a subject and a body.
     * A refusal is a 422 the person reads, in the reason class's own words, and NO draft: a
     * redacted draft would be a false state about what the model was shown and what it wrote.
     */
    const screened = screenModelInput([
      { label: "incoming", fields: [target.subject, target.snippet, target.fromAddress] },
      ...kbHits.map((e) => ({ label: "kb", fields: [e.title, e.content] })),
      ...threadMessages.map((m) => ({ label: "thread", fields: [m.snippet, m.from] })),
    ]);
    if (!screened.admitted) {
      throw new ServiceError(
        "credential_screened", 422,
        `${MODEL_SINK_REFUSAL_SENTENCE[screened.reason]}, so no draft was generated`,
        { reason: screened.reason },
      );
    }

    const input: DraftInput = {
      incoming: {
        subject: target.subject,
        from: target.fromAddress,
        snippet: target.snippet,
      },
      context: {
        kbEntries: kbHits.map((e) => ({ title: e.title, content: e.content })),
        threadMessages,
      },
    };

    return this.chargedDraft(ctx, deps, {
      window, input, mailboxId: target.mailboxId, meta: { messageId: target.id },
      keyOf: () => this.debitKey(target.id, deps),
      // The model answers in PROSE; promotion into the outbound grammar makes the eventual send a
      // genuine `multipart/alternative`. ONLY the html is passed: `DraftsService.create` refuses a
      // `body` alongside it and derives the text half from the SANITIZED markup — the rule that
      // makes the two parts unable to disagree. An empty promotion stores a plain draft.
      store: (result, idempotency) => {
        const promoted = plainTextToOutboundBody(result.body);
        return this.drafts.create(ctx, {
          mailboxId: target.mailboxId,
          threadId: target.threadId ?? null,
          inReplyToMessageId: target.id,
          subject: result.subject,
          ...(promoted.html ? { html: promoted.html } : { body: result.body }),
          rationale: result.rationale,
        }, { idempotency });
      },
    });
  }

  /**
   * A DRAFT FROM THE PERSON'S OWN WORDS: `text` says what the letter should say; a letter named
   * by `inReplyToMessageId` is answered, read as context; without one, `mailboxId` names where the
   * draft is written. The doors in order: the words, the letter (404, a differing mailbox 400, a
   * sensitive letter 422 before any context), the context, the credential door with the words as
   * their own document, then {@link chargedDraft}'s: the refund memory, the mailbox, the
   * admission, the spend, the model, the refund, the store. Stored, never sent.
   */
  async draftFromText(
    ctx: ServiceContext,
    body: UntrustedBody<DraftFromTextBody>,
    deps: DraftFromMessageDeps,
  ): Promise<{ draftId: string; seq: number }> {
    const window = draftWindow(this.opts.invocationBudgetMs, Date.now(), this.opts.admission);
    // 1. The words, and the body's other fields, each its type or a 400.
    const raw = (body ?? {}) as Record<string, unknown>;
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (text.length === 0 || text.length > DRAFT_OWN_TEXT_MAX_CHARS) {
      throw new ServiceError("validation_failed", 400, `text is required: 1 to ${DRAFT_OWN_TEXT_MAX_CHARS} characters`);
    }
    if (raw.subject !== undefined && (typeof raw.subject !== "string" || raw.subject.length > DRAFT_SUBJECT_MAX_CHARS)) {
      throw new ServiceError("validation_failed", 400, `subject must be a string of at most ${DRAFT_SUBJECT_MAX_CHARS} characters`);
    }
    const subject = typeof raw.subject === "string" && raw.subject.trim() !== "" ? raw.subject : undefined;
    const letterId = optionalId(raw.inReplyToMessageId, "inReplyToMessageId");
    const mailboxId = optionalId(raw.mailboxId, "mailboxId");

    // 2. The letter answered, account-scoped, refused before any context when it may not reach a model.
    const letter = letterId === undefined ? null : await this.letterOf(ctx, letterId);
    if (letter !== null && mailboxId !== undefined && mailboxId !== letter.mailboxId) {
      throw new ServiceError("validation_failed", 400, "mailboxId is not the mailbox of the letter answered");
    }
    if (letter === null && mailboxId === undefined) {
      throw new ServiceError("validation_failed", 400, "mailboxId is required when no letter is answered");
    }
    const where = letter?.mailboxId ?? mailboxId!;

    // 3. The context: the knowledge base, asked with the letter's hint or the words, and the thread only with a letter.
    const kbHits = await this.kb.retrieve(ctx, letter !== null ? kbHintOf(letter) : text.slice(0, SEARCH_QUERY_MAX_CHARS), deps.k ?? DEFAULT_KB_K);
    const threadMessages = letter?.threadId ? await this.retrieveThreadContext(ctx, letter.threadId, letter.id) : [];

    // 4. THE DOOR, the person's words their own document: a credential in them is said about them.
    const screened = screenModelInput([
      { label: "own", fields: [text, subject] },
      ...(letter !== null ? [{ label: "incoming", fields: [letter.subject, letter.snippet, letter.fromAddress] }] : []),
      ...kbHits.map((e) => ({ label: "kb", fields: [e.title, e.content] })),
      ...threadMessages.map((m) => ({ label: "thread", fields: [m.snippet, m.from] })),
    ]);
    if (!screened.admitted) {
      const sentence = screened.where === "own" ? OWN_WORDS_REFUSAL_SENTENCE[screened.reason] : MODEL_SINK_REFUSAL_SENTENCE[screened.reason];
      throw new ServiceError("credential_screened", 422, `${sentence}, so no draft was generated`, { reason: screened.reason });
    }

    const input: DraftInput = {
      incoming: letter !== null ? { subject: letter.subject, from: letter.fromAddress, snippet: letter.snippet } : { ...NO_LETTER },
      context: {
        kbEntries: kbHits.map((e) => ({ title: e.title, content: e.content })),
        threadMessages,
      },
      own: { text, replying: letter !== null, ...(subject !== undefined ? { subject } : {}) },
    };
    const anchor = letter?.id ?? where;
    return this.chargedDraft(ctx, deps, {
      window, input, mailboxId: where,
      meta: letter !== null ? { messageId: letter.id } : { mailboxId: where },
      keyOf: () => {
        if (!deps.attemptKey) throw new ServiceError("internal", 500, "AI drafting is metered on this deployment but no client Idempotency-Key was threaded through");
        return draftFromTextAttemptKey(anchor, deps.attemptKey);
      },
      store: (result, idempotency) => {
        const promoted = plainTextToOutboundBody(result.body);
        return this.drafts.create(ctx, {
          mailboxId: where,
          ...(letter !== null ? { inReplyToMessageId: letter.id, threadId: letter.threadId ?? null } : {}),
          subject: subject ?? result.subject,
          ...(promoted.html ? { html: promoted.html } : { body: result.body }),
          rationale: result.rationale,
        }, { idempotency });
      },
    });
  }

  /** The letter a draft answers, account-scoped: another account's id is a 404, and a sensitive one a 422. */
  private async letterOf(ctx: ServiceContext, id: string) {
    const [target] = await ctx.db
      .select({
        id: messages.id, mailboxId: messages.mailboxId, threadId: messages.threadId, subject: messages.subject,
        fromAddress: messages.fromAddress, snippet: messages.snippet, noAi: messages.noAi, sensitivityCategory: messages.sensitivityCategory,
      })
      .from(messages)
      .where(and(eq(messages.id, id), eq(messages.accountId, ctx.accountId)))
      .limit(1);
    if (!target) throw new ServiceError("not_found", 404, "message not found");
    if (target.noAi || target.sensitivityCategory !== null) {
      throw new ServiceError("sensitive_no_ai", 422, "cannot AI-draft a sensitive message");
    }
    return target;
  }

  /**
   * THE PAID TAIL OF EVERY DRAFT, from the charge to the stored row, one path for each route that
   * writes a draft with a model: the refusal of a metered host with no refund memory, the
   * admission, the spend, the model call cut at the deadline, the refund of a failed call, the
   * store and the usage release. `keyOf` names the attempt in the ledger (asked only when metered);
   * `meta` rides on every ledger call and log line.
   */
  private async chargedDraft(
    ctx: ServiceContext,
    deps: DraftFromMessageDeps,
    o: DraftWork,
  ): Promise<{ draftId: string; seq: number }> {
    // Validate the mailbox and refund store before claiming the key or charging.
    if (deps.credits && !deps.obligations) {
      throw new ServiceError(
        "internal", 500,
        "AI drafting is metered on this deployment but no refund-obligation store was composed",
      );
    }
    // A MAILBOX THAT CANNOT HOLD THE DRAFT, before a credit moves: the store would refuse it after
    // the charge, and every free retry would refuse again.
    await this.drafts.validMailbox(ctx, o.mailboxId);
    const attemptKey = deps.credits ? o.keyOf() : null;
    const receipt = deps.credits && deps.idempotency
      ? await claimDraftReceipt(ctx, deps.idempotency, this.opts.invocationBudgetMs)
      : null;
    try {
      // Reaching the model with enough time includes the time taken to reserve the key.
      if (o.window !== null && Date.now() > o.window.admitUntil) {
        throw new ServiceError("ai_unavailable", 503, "AI drafting is temporarily unavailable; please retry");
      }
      return await this.runDraft(ctx, deps, o, attemptKey, receipt);
    } catch (err) {
      await receipt?.abandon();
      throw err;
    }
  }

  private async runDraft(
    ctx: ServiceContext, deps: DraftFromMessageDeps, o: DraftWork, attemptKey: string | null, receipt: DraftReceipt | null,
  ): Promise<{ draftId: string; seq: number }> {
    const { window, input, meta } = o;
    let paid = false;
    /** The attempt THIS request charged, or null. The port's `attempt` is the refund memory. */
    let chargedAttempt: string | null = null;
    /** The drafter's usage, carried by whichever release runs — a failed call's line included. */
    const usage = usageLines(this.opts.usageHost, ctx.accountId, "draft");
    let released = false;
    /**
     * THE ONE DOOR TO THE GATE'S RELEASE, once per request (`released` set before the await). A
     * reversal only for an attempt THIS request charged, through `reverseCharge`: the debt is
     * written before the reversal is tried, a write that throws is named and the reversal still
     * tried, and only a written debt is settled. `owed` says whether a debt is on record, which
     * decides the sentence. `null` when nothing was released: unmetered, or the door already used.
     */
    const releaseClaim = async (refund: boolean): Promise<ReverseChargeResult | null> => {
      if (!deps.credits || !attemptKey || released) return null;
      released = true;
      if (!refund || chargedAttempt === null) {
        const receipt = await deps.credits.release(
          ctx.accountId, { action: "draft", attemptKey, refund: false, meta, ...usage.field() });
        return { receipt, owed: false };
      }
      const attempt = chargedAttempt;
      return reverseCharge(deps.credits, deps.obligations, {
        accountId: ctx.accountId, action: "draft", attemptKey, attempt, reason: "drafter_failed", meta,
        ...usage.field(),
      }, (f) => sayDraftRefund(f, ctx.accountId, attempt));
    };
    if (deps.credits && attemptKey) {
      const outcome = await deps.credits.spend(ctx.accountId, "draft", attemptKey, meta);
      paid = outcome.verdict === "ok" || outcome.verdict === "duplicate";
      chargedAttempt = outcome.verdict === "ok" ? outcome.attempt : null;
      if (outcome.verdict === "fault" || outcome.verdict === "inflight") {
        await refuseAiSpend(
          { refusal: "fault", verdict: outcome.verdict },
          {
            event: "draft_refused",
            accountId: ctx.accountId,
            unavailable: "AI drafting is temporarily unavailable; please retry",
          },
        );
      }
      if (outcome.verdict === "refused" || outcome.verdict === "insufficient") {
        // ONE PLACE DECIDES, for this call site and the Screener's — see `ai-refusal.ts`. It
        // writes the line naming the verdict and the reason, answers 409 for the account's own
        // off switch BY REASON rather than by verdict (the switch arrives as `refused` from one
        // implementation and `insufficient` from the other), and refuses to turn a `state`
        // refusal this account's own access view contradicts into a payment demand. The
        // machine-readable `reason` still rides on the 402 so a client can tell "buy more" from
        // "fix your subscription".
        await refuseAiSpend(
          {
            refusal: outcome.verdict === "insufficient" ? "quantity" : "state",
            verdict: outcome.verdict,
            reason: outcome.reason,
          },
          {
            event: "draft_refused",
            accountId: ctx.accountId,
            ...(deps.access ? { access: deps.access } : {}),
            unavailable: "AI drafting is temporarily unavailable; please retry",
          },
        );
      }
    }

    // An interrupted model call is refundable until it has delivered preview text.
    const { access } = deps;
    // The authenticated drafting request carries this press. A managed account also needs current AI access.
    const consent = modelConsentGate(() => access ? readManagedModelConsent(bridgeTx(ctx.db), ctx.accountId, access) : true);
    let previewed = false;
    const onPreview = deps.onPreview && ((text: string) => {
      previewed = true;
      deps.onPreview!(text);
    });
    const unrecorded = (why: string, err?: unknown): void => log.warn("draft_usage_unrecorded", {
      accountId: ctx.accountId, ...meta, why, ...(err === undefined ? {} : { err }),
    });
    const failAfterPreview = async (declined = false): Promise<never> => {
      const failure = declined ? draftDeclined("used") : new ServiceError(
        "ai_draft_failed", 503, "the draft stopped; your credits were used", { credits: "used" }, false,
      );
      try {
        await receipt?.fail(failure);
      } finally {
        // The receipt survives an unavailable usage release. A preview is never refundable.
        try {
          if ((await releaseClaim(false))?.receipt === "unreachable") unrecorded("unreachable");
        } catch (err) {
          unrecorded("release_failed", err);
        }
      }
      throw failure;
    };
    let result;
    try {
      result = await draftWithin(deps.drafter, input, window?.modelDeadline ?? null,
        { ...usage.call, beforeDispatch: consent.beforeDispatch, onPreview });
    } catch (err) {
      // A DECLINE IS SAID AS ONE: a 422 the person can read, never a retryable 503 — pressing again
      // draws the same refusal. The credits take the same two states as any failed draft.
      const declined = err instanceof ModelDeclinedError;
      const failure = err instanceof ModelConsentWithdrawn
        ? new ServiceError("ai_unavailable", 503, "AI drafting is temporarily unavailable; please retry")
        : err;
      // `refund: true` only for an attempt THIS request charged. A `duplicate` names an earlier
      // attempt whose work may have been delivered, and reversing that one because this request
      // failed would hand back a charge for a draft the customer already has.
      if (previewed && paid) return failAfterPreview(declined);
      if (deps.credits && attemptKey) {
        if (chargedAttempt === null) {
          // Nothing moved, so nothing is owed: the claim goes back and the caller's own error
          // stands. A lost release here costs the customer nothing — the attempt stays open and
          // the retry is free.
          await releaseClaim(false);
          if (declined) throw draftDeclined(null);
          throw failure;
        }
        const done = await releaseClaim(true);
        // AND THE PERSON IS TOLD WHICH OF THE TWO HAPPENED: `returned` is money already back,
        // `owed` is money a pass will return, and `owed` only where the debt is ON RECORD. A
        // reversal the program did not take, whose debt could not be written either, promises
        // nothing: the answer is the uncharged one, whose same-key retry is free because the
        // attempt stays open. A 500 would render as "internal error" and lose the money's state.
        const back = done?.receipt === "settled" ? "returned" : done?.owed ? "owed" : null;
        if (declined) throw draftDeclined(back);
        if (back === null) throw failure;
        throw new ServiceError(
          "ai_draft_failed", 503,
          back === "returned"
            ? "the draft could not be written; your credits are back"
            : "the draft could not be written; your credits will be returned",
          { credits: back },
          true,
        );
      }
      if (declined) throw draftDeclined(null);
      throw failure;
    }

    // THE USAGE RELEASE, sent after the store below: the lesser fact. A plain release moves no money on this
    // action, so it carries the line and nothing else, and only while the release, the fault
    // record a timed-out one writes and the response all fit before the platform's kill. A skip
    // or a fault is a line in the log, never the person's error.
    const sendUsage = async (): Promise<void> => {
      if (usage.count === 0 || !deps.credits || !attemptKey) return;
      const admission = this.opts.admission ?? DRAFT_ADMISSION;
      const tail = admission.spendCallCeilingMs + DRAFT_USAGE_RELEASE.faultRecordMs + DRAFT_USAGE_RELEASE.responseMarginMs;
      if (window !== null && Date.now() + tail > window.modelDeadline + admission.closeReserveMs) {
        unrecorded("no_time");
        return;
      }
      try {
        if ((await releaseClaim(false))?.receipt === "unreachable") unrecorded("unreachable");
      } catch (err) {
        // A release that threw is this log line, never the person's error.
        unrecorded("release_failed", err);
      }
    };

    let stored: { draft: { id: string }; seq: number };
    try {
      stored = await o.store(result, receipt?.idempotency ?? deps.idempotency);
    } catch (err) {
      if (previewed && paid && !(err instanceof IdempotencyRaceLost)) return failAfterPreview();
      if (usage.count > 0 && deps.credits && attemptKey) unrecorded("store_failed");
      await sendUsage();
      throw err;
    }
    // 7. The usage, now that the draft is durable.
    await sendUsage();

    return { draftId: stored.draft.id, seq: stored.seq };
  }

  /**
   * The ledger identity of one AI draft attempt — `draft:<target message id>:<hashed
   * Idempotency-Key>`. Two notes, both forced by the shipped route: the first component is the
   * TARGET message, not a draft row id — at charge time, before the model runs, no draft row
   * exists, and the message being replied to is what the user pointed at. And the attempt key is
   * the CLIENT's: a missing key with metering enabled is a programmer error (the route rejects
   * long before this), never a server-minted uuid — minting one would charge a retry of a lost
   * response a second time, the exact failure the branded {@link IdempotencyKey} makes
   * unrepresentable.
   */
  private debitKey(messageId: string, deps: DraftFromMessageDeps): string {
    if (!deps.attemptKey) {
      throw new ServiceError(
        "internal", 500,
        "AI drafting is metered on this deployment but no client Idempotency-Key was threaded through",
      );
    }
    return draftAttemptKey(messageId, deps.attemptKey);
  }

  /**
   * The target thread's OTHER messages as redacted snippets, with the
   * sensitivity exclusion STRUCTURAL in the WHERE: `no_kb = false AND
   * no_ai = false AND sensitivity_category IS NULL`. Break any of these predicates
   * and an excluded sibling would leak into the DraftPort input. accountId-scoped.
   */
  private async retrieveThreadContext(
    ctx: ServiceContext,
    threadId: string,
    excludeId: string,
  ): Promise<Array<{ from: string; snippet: string }>> {
    const rows = await ctx.db
      .select({ from: messages.fromAddress, snippet: messages.snippet })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, ctx.accountId),
          eq(messages.threadId, threadId),
          ne(messages.id, excludeId),
          eq(messages.noKb, false),
          eq(messages.noAi, false),
          isNull(messages.sensitivityCategory),
        ),
      )
      .orderBy(asc(messages.date))
      .limit(MAX_THREAD_MESSAGES);
    return rows.map((r) => ({ from: r.from, snippet: r.snippet }));
  }
}

/**
 * The model declined or hit its output limit. Report the credit outcome when known.
 */
function draftDeclined(credits: "returned" | "owed" | "used" | null): ServiceError {
  const message = credits === "returned"
    ? "the model declined to write this draft; your credits are back"
    : credits === "owed"
      ? "the model declined to write this draft; your credits will be returned"
      : credits === "used"
        ? "the draft stopped; your credits were used"
        : "the model declined to write this draft";
  return new ServiceError("ai_draft_declined", 422, message, credits === null ? undefined : { credits }, false);
}

/**
 * THE MODEL CALL, CUT AT THE DEADLINE. The drafter is handed the signal (the live client stops
 * retrying and waiting on it) AND raced against it here, so a drafter that ignores the signal
 * still cannot hold the request past the time the close was promised. The caller's catch releases
 * the attempt and determines the refund.
 */
async function draftWithin(
  drafter: DraftPort, input: DraftInput, deadline: number | null, call: DraftCallOptions | undefined,
): Promise<Awaited<ReturnType<DraftPort["draft"]>>> {
  // The usage hook rides BOTH arms: an arm without it is a call nobody attributes.
  if (deadline === null) {
    if (call?.beforeDispatch) await call.beforeDispatch();
    return call ? drafter.draft(input, call) : drafter.draft(input);
  }
  const cut = (): ServiceError =>
    new ServiceError("ai_unavailable", 503, "the drafting model did not answer in time; please retry");
  const left = deadline - Date.now();
  if (left <= 0) throw cut();
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        if (call?.beforeDispatch) await call.beforeDispatch();
        if (ac.signal.aborted) throw cut();
        return drafter.draft(input, { ...call, signal: ac.signal });
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { ac.abort(); reject(cut()); }, left);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const draftingService = new DraftingService();

/** A drafting service for a host that states the ceiling it kills a request at (see the constructor). */
export function makeDraftingService(
  opts: { invocationBudgetMs?: number; usageHost?: AiUsageHost } = {},
): DraftingService {
  return new DraftingService(undefined, undefined, opts);
}
