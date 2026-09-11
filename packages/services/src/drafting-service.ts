import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { messages, draftAttemptKey, type IdempotencyKey } from "@trafficflow/db";
// TYPE-ONLY, and it has to stay that way: `import type` is erased, so it creates no module edge
// into the hosted half. A value import from `/cloud` here would put billing and the ledger into
// the desktop engine, which mounts this service.
/* The PORT, from the root barrel — not `@trafficflow/db/cloud`, which is the half that
 * answers. This service names a gate it may be handed; it never builds one, and it must
 * compile in a deployment where no gate and no ledger exist. */
import type { SpendPort } from "@trafficflow/db";
import { plainTextToOutboundBody, type DraftInput, type DraftPort } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { DraftsService, type DraftCreateIdempotency } from "./drafts-service.js";
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

/** How many KB entries and thread messages to retrieve as grounding context. */
const DEFAULT_KB_K = 5;
const MAX_THREAD_MESSAGES = 20;

/**
 * The per-call drafting deps: the INJECTED DraftPort (mocked in tests; a real
 * `makeSonnetDrafter(new Anthropic())` in prod) plus retrieval knobs. The port is
 * passed per-call — the service itself holds no live model client.
 */
export interface DraftFromMessageDeps {
  drafter: DraftPort;
  /** KB retrieval top-k (default 5). */
  k?: number;
  /**
   * The AI spend gate. Absent ⇒ unmetered (the desktop tier and tests written before
   * metering existed). Present ⇒ {@link DraftFromMessageDeps.attemptKey} is REQUIRED, because a metered AI
   * action must carry the client's own statement of intent.
   */
  credits?: SpendPort;
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
  /** Claim the idempotency row inside the tx that stores the draft (see below). */
  idempotency?: DraftCreateIdempotency;
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
  ) {}

  async draftFromMessage(
    ctx: ServiceContext,
    messageId: string,
    deps: DraftFromMessageDeps,
  ): Promise<{ draftId: string; seq: number }> {
    // 1. Load the target — account-scoped: a cross-account id is a 404.
    const [target] = await ctx.db
      .select({
        id: messages.id,
        mailboxId: messages.mailboxId,
        threadId: messages.threadId,
        subject: messages.subject,
        fromAddress: messages.fromAddress,
        snippet: messages.snippet,
        noAi: messages.noAi,
        sensitivityCategory: messages.sensitivityCategory,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId)))
      .limit(1);
    if (!target) throw new ServiceError("not_found", 404, "message not found");

    // 2. Refuse a sensitive / no_ai target. We reject BEFORE reading any
    //    body or assembling context — the sensitive message never reaches the model.
    if (target.noAi || target.sensitivityCategory !== null) {
      throw new ServiceError("sensitive_no_ai", 422, "cannot AI-draft a sensitive message");
    }

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
    const snippet = target.snippet.slice(0, KB_HINT_SNIPPET_CHARS);
    // The joining space is only spent when there IS a snippet — subtracting it unconditionally
    // took a character off the subject of a message with no snippet at all, for a separator the
    // `trim()` below then removed.
    const subjectRoom = SEARCH_QUERY_MAX_CHARS - snippet.length - (snippet.length > 0 ? 1 : 0);
    const query = `${target.subject.slice(0, Math.max(0, subjectRoom))} ${snippet}`.trim();
    const kbHits = await this.kb.retrieve(ctx, query, deps.k ?? DEFAULT_KB_K);
    const threadMessages = target.threadId
      ? await this.retrieveThreadContext(ctx, target.threadId, target.id)
      : [];

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

    // 4. CHARGE, immediately before the model and nowhere earlier. Order matters three times:
    // AFTER the refusal check, so a `no_ai`/sensitive target 422s without touching the ledger
    // (zero rows, asserted against the ledger itself); AFTER context assembly, so only fallible
    // work that costs tokens sits behind the charge; BEFORE the drafter, because "revenue
    // precedes token spend" is only structural if an empty balance stops the request first —
    // which also turns out-of-credits into a clean 402 instead of a 500 from inside a model
    // client. `spend`, not `tryDebit`: "out of credits", "subscription may not spend" and "ledger
    // unreachable" are three different answers, and collapsing them into a boolean is what made a
    // funded customer receive 402 for a dropped connection. The BARE key — the ledger source is
    // composed by whoever answers, so this path cannot double-prefix it.
    const attemptKey = deps.credits ? this.debitKey(target.id, deps) : null;
    /** The attempt THIS request charged, or null. The port's `attempt` is the refund memory. */
    let chargedAttempt: string | null = null;
    if (deps.credits && attemptKey) {
      const outcome = await deps.credits.spend(
        ctx.accountId, "draft", attemptKey, { messageId: target.id });
      chargedAttempt = outcome.verdict === "ok" ? outcome.attempt : null;
      if (outcome.verdict === "fault") {
        // A SERVER fault. 503, never 402 — we do not bill someone for our own outage, and we
        // do not tell them to buy credits they already have. Retryable, and the gate has
        // already reported the underlying error through `onError`.
        throw new ServiceError(
          "ai_unavailable", 503, "AI drafting is temporarily unavailable; please retry",
        );
      }
      if (outcome.verdict === "inflight") {
        // Another caller holds this draft's claim. 503, emphatically not 402: this account is
        // fully funded, so a demand for money would be a bill for someone else's concurrency; the
        // retry is free — the holder's charge pays for it. Unreachable today: the gate this
        // service is handed does not ask for exclusivity. The case it would close is two same-key
        // requests both missing the stored-response lookup and both calling the model. Switching
        // that on is a host decision, deliberately not made here — the loser of that race is a
        // person waiting on a draft, and that answer deserves designing. This branch exists so
        // the day it IS switched on is not also the day a concurrency overlap starts answering
        // 402.
        throw new ServiceError(
          "ai_unavailable", 503, "AI drafting is temporarily unavailable; please retry",
        );
      }
      // BY REASON AND NOT BY VERDICT, which is how this line has always read. The switch arrives
      // as `refused` from both implementations; accepting it under `insufficient` too is the
      // fail-safe against the one drift that matters here — a state refusal folded into an
      // out-of-credits answer bills a fully funded account for a setting it chose.
      if ((outcome.verdict === "refused" || outcome.verdict === "insufficient")
        && outcome.reason === "ai_disabled") {
        // THE ACCOUNT'S OWN OFF SWITCH — 409, never 402. 402 means "pay us", and it would be the
        // wrong sentence three times over: this account is fully funded, nothing it could buy
        // would change the answer, and the state was chosen deliberately by the person now
        // being asked for money. 409 says what is true — the request conflicts with a setting
        // on this account — and the `reason` tells the client which setting to offer to change.
        throw new ServiceError(
          "ai_disabled", 409, "managed AI is switched off for this account",
          { reason: outcome.reason },
        );
      }
      if (outcome.verdict === "refused" || outcome.verdict === "insufficient") {
        // A machine-readable WHY, so the client can tell "buy more" from "fix your
        // subscription" instead of guessing. It comes from the decision the gate already made
        // rather than from a second read of the same subscription.
        throw new ServiceError(
          "insufficient_credits", 402, "no AI actions remain on this account",
          { reason: outcome.reason },
        );
      }
    }

    // 5. Call the injected drafter (the mock in tests). A throw here means we charged for a
    //    call that produced nothing.
    //
    //    This path DOES refund, unlike `pipeline.ts`, and the difference is who owns the
    //    retry. A classifier fault leaves the message un-ingested, so the worker re-plans it by
    //    construction and the free retry honours the charge. Here the retry belongs to a human
    //    who has just been handed a 500 and may never come back, so an un-refunded charge could
    //    buy nothing at all. The refund CLOSES the attempt, so a same-key retry is charged
    //    afresh rather than served free — which is what stops refund-plus-retry from composing
    //    into unlimited free drafts.
    let result;
    try {
      result = await deps.drafter.draft(input);
    } catch (err) {
      // `refund: true` only for an attempt THIS request charged. A `duplicate` names an earlier
      // attempt whose work may have been delivered, and reversing that one because this request
      // failed would hand back a charge for a draft the customer already has.
      if (deps.credits && attemptKey) {
        const meta = { messageId: target.id };
        await deps.credits.release(ctx.accountId, chargedAttempt === null
          ? { action: "draft", attemptKey, refund: false, meta }
          : { action: "draft", attemptKey, refund: true, attempt: chargedAttempt, meta });
      }
      throw err;
    }

    // 6. STORE as a `drafts` row (status 'draft') via DraftsService — the `draft` change row
    // in-tx; never sent. With an idempotency handle, the verbatim 202 is claimed in the SAME
    // transaction, so a same-key retry replays it instead of storing a second draft. A failure
    // here leaves the charge standing with no draft, deliberately not refunded: the attempt stays
    // OPEN, so the retry is free — bounded to `IDEMPOTENCY_TTL_MS`, never a permanent licence.
    // The model answers in PROSE; promotion into the outbound grammar makes the eventual send a
    // genuine `multipart/alternative`. ONLY the html is passed: `DraftsService.create` refuses a
    // `body` alongside it and derives the text half from the SANITIZED markup — the rule that
    // makes the two parts unable to disagree. An empty promotion stores a plain draft.
    const promoted = plainTextToOutboundBody(result.body);
    const { draft, seq } = await this.drafts.create(ctx, {
      mailboxId: target.mailboxId,
      threadId: target.threadId ?? null,
      inReplyToMessageId: target.id,
      subject: result.subject,
      ...(promoted.html ? { html: promoted.html } : { body: result.body }),
      rationale: result.rationale,
    }, { idempotency: deps.idempotency });

    return { draftId: draft.id, seq };
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

export const draftingService = new DraftingService();
