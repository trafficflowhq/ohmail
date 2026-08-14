import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { messages, ledgerSources, type IdempotencyKey } from "@trafficflow/db";
// TYPE-ONLY, and it has to stay that way: `import type` is erased, so it creates no module edge
// into the hosted half. A value import from `/cloud` here would put billing and the ledger into
// the desktop engine, which mounts this service.
/* The PORT, from the root barrel — not `@trafficflow/db/cloud`, which is the half that
 * answers. This service names a gate it may be handed; it never builds one, and it must
 * compile in a deployment where no gate and no ledger exist. */
import type { AiCreditGate } from "@trafficflow/db";
import { plainTextToOutboundBody, type DraftInput, type DraftPort } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { DraftsService, type DraftCreateIdempotency } from "./drafts-service.js";
import { KbService } from "./kb-service.js";

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
  credits?: AiCreditGate;
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
 * DraftingService — the AI draft-from-history flow. It assembles a
 * SENSITIVITY-SAFE context, calls the injected DraftPort, and STORES the result as
 * a `drafts` row (never sent). The three binding invariants:
 *
 *  - REFUSAL: if the TARGET message is `no_ai` OR sensitive
 *    (`sensitivityCategory != null`) it THROWS 422 `sensitive_no_ai` BEFORE any
 *    context is assembled — the target body is never read and the drafter is never
 *    called (its call-count stays 0).
 *  - CONTEXT: the draft context = KB retrieval (`KbService.retrieve`) + the target
 *    thread's OTHER messages as redacted snippets. No sent-mail voice corpus (that
 *    corpus is not populated; deferred).
 *  - SENSITIVITY EXCLUSION: the thread-context retrieval carries it
 *    STRUCTURALLY in the SQL WHERE (`no_kb = false AND no_ai = false AND
 *    sensitivity_category IS NULL`), so a `no_kb`/`no_ai`/sensitive sibling can
 *    never reach the DraftPort input — not a post-filter that could be forgotten.
 *
 * Storing goes through `DraftsService.create` so the `draft` change_log row is
 * emitted in-tx (no tombstone) and the mailbox ownership re-checked.
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
    const query = `${target.subject} ${target.snippet}`.trim();
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

    // 4. CHARGE, immediately before the model and nowhere earlier.
    //
    //    Order matters three times over. It is AFTER the refusal check, so a `no_ai` /
    //    sensitive target 422s without ever touching the ledger (zero rows,
    //    asserted against the ledger itself and not against the drafter's call count). It is
    //    AFTER context assembly, so only fallible work that actually costs tokens sits behind
    //    the charge. And it is BEFORE the drafter, because "revenue precedes token spend" is
    //    only structural if an empty balance stops the request before it costs us a token —
    //    which is also what turns the out-of-credits case into a clean 402 instead of a 500
    //    from three frames down inside a model client.
    //
    //    `spend`, not `tryDebit`: on a REQUEST path the difference between "you are out of
    //    credits", "your subscription may not spend" and "our ledger is unreachable" is the
    //    difference between three different answers, and collapsing them into one boolean is
    //    what made a funded customer receive `402 out_of_credits` for a dropped connection.
    const creditSource = deps.credits ? this.debitSource(target.id, deps) : null;
    if (deps.credits && creditSource) {
      const outcome = await deps.credits.spend(creditSource, { messageId: target.id });
      if (!outcome.permitted && outcome.refusal === "fault") {
        // A SERVER fault. 503, never 402 — we do not bill someone for our own outage, and we
        // do not tell them to buy credits they already have. Retryable, and the gate has
        // already reported the underlying error through `onError`.
        throw new ServiceError(
          "ai_unavailable", 503, "AI drafting is temporarily unavailable; please retry",
        );
      }
      if (!outcome.permitted && outcome.refusal === "inflight") {
        // ANOTHER CALLER HOLDS THIS DRAFT'S CLAIM (SEC3-MONEY-1). 503 for the same reason a fault
        // is 503 and emphatically not 402: this account is fully funded and nothing is wrong with
        // it, so a demand for money would be a bill for someone else's concurrency. Retryable,
        // and the retry is free — the holder's charge is what pays for it.
        //
        // Unreachable today: the gate this service is handed does not ask for exclusivity. The
        // case it would close is two same-key requests both missing the stored-response lookup
        // (which runs in autocommit, before either transaction opens) and both calling the model.
        // Switching it on is one option at whichever host constructs the gate, and it is
        // deliberately not switched on here: the loser of that race is a person waiting on a
        // draft, and that answer deserves designing rather than inheriting from a change made for
        // a different call site. This branch exists so that the day it IS switched on is not also
        // the day a concurrency overlap starts answering 402.
        throw new ServiceError(
          "ai_unavailable", 503, "AI drafting is temporarily unavailable; please retry",
        );
      }
      if (!outcome.permitted && outcome.reason === "ai_disabled") {
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
      if (!outcome.permitted) {
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
      if (creditSource) await deps.credits?.refund(creditSource, { messageId: target.id });
      throw err;
    }

    // 6. STORE as a `drafts` row (status 'draft') via DraftsService — emits the
    //    `draft` change_log row in-tx. NEVER sent (the gated send is a separate path). When the
    //    route supplied an idempotency handle, the verbatim 202 response is claimed in that SAME
    //    transaction, so a same-key retry replays it instead of storing a second draft.
    //
    //    A failure HERE — a lost idempotency claim, a crash before commit — leaves the charge
    //    standing with no draft delivered, and that is deliberately not refunded: the attempt
    //    stays OPEN, so the client's same-key retry is free and delivers the draft the charge
    //    already paid for. The gate bounds that free window to `IDEMPOTENCY_TTL_MS`, i.e. to
    //    exactly as long as the HTTP layer still honours the key, so it cannot become a
    //    permanent licence to re-draft.
    //
    //    The model answers in PROSE, and a stored draft has room for two halves. Promoting the
    //    words into the outbound grammar here is what makes the eventual send a genuine
    //    `multipart/alternative` instead of `text/plain` — the reply is composed in a rich
    //    editor either way, so a plain-only send was the one shape nobody chose.
    //
    //    ONLY the html is passed. `DraftsService.create` refuses a `body` sent alongside it and
    //    derives the text half from the SANITIZED markup itself, which is the rule that makes
    //    the two parts unable to disagree; a caller exempting itself from it because it happens
    //    to know both halves agree is how the next caller comes to know wrongly. The promotion
    //    normalizes whitespace, so the stored text is what a reader of the markup will see
    //    rather than the model's raw bytes — for an ordinary reply the two are the same string.
    //
    //    An empty promotion means the model returned nothing but whitespace. That stores as a
    //    plain draft exactly as before: an empty paragraph is not an improvement on an empty
    //    body, and the compose surface has always been able to hold one.
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
   * The ledger identity of ONE AI draft attempt — `draft:<target message id>:<hashed
   * Idempotency-Key>`.
   *
   * Two notes on the idempotency registry, both forced by the shipped route rather than chosen:
   *
   *  · the first component is the TARGET message, not a draft row id. `POST /messages/:id/draft`
   *    creates the draft from the model's answer, so at charge time — which must be before the
   *    model runs — no draft row exists. The message being replied to is the only identity
   *    available, and it is the right one: it is what the user pointed at.
   *  · the attempt key does all of the idempotency work, and it is the CLIENT's. That is why
   *    a missing key with metering enabled is a programmer error here (the route rejects the
   *    request long before this) rather than a server-minted uuid: minting one would charge a
   *    retry of a lost response a second time, which is the exact failure the branded
   *    {@link IdempotencyKey} exists to make unrepresentable.
   */
  private debitSource(messageId: string, deps: DraftFromMessageDeps): string {
    if (!deps.attemptKey) {
      throw new ServiceError(
        "internal", 500,
        "AI drafting is metered on this deployment but no client Idempotency-Key was threaded through",
      );
    }
    return ledgerSources.draft(messageId, deps.attemptKey);
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
