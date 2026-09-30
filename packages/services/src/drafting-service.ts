import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { messages, draftAttemptKey, type IdempotencyKey } from "@trafficflow/db";
// TYPE-ONLY, and it has to stay that way: `import type` is erased, so it creates no module edge
// into the hosted half. A value import from `/cloud` here would put billing and the ledger into
// the desktop engine, which mounts this service.
/* The PORT, from the root barrel — not `@trafficflow/db/cloud`, which is the half that
 * answers. This service names a gate it may be handed; it never builds one, and it must
 * compile in a deployment where no gate and no ledger exist. */
import type {
  AccessPort, AiUsageHost, RefundObligationPort, ReleaseReceipt, SpendPort,
} from "@trafficflow/db";
import {
  createLogger, plainTextToOutboundBody, screenModelInput, MODEL_SINK_REFUSAL_SENTENCE,
  type AiCallOptions, type DraftInput, type DraftPort,
} from "@trafficflow/core/mail";
import { usageLines } from "./ai-usage-lines.js";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { refuseAiSpend } from "./ai-refusal.js";
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

const log = createLogger({ service: "drafting" });

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
   * THE ACCESS HALF, READ ONLY WHEN THE GATE HAS ALREADY REFUSED — never on the way in.
   *
   * The Screener's twin dep, for the twin rule: a `state` refusal is cross-checked against a
   * fresh read of this account's access, and one that says AI is available answers 503 rather
   * than demanding money. ABSENT is a host that wired no such reader, and then a refusal answers
   * what it always answered.
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
    // A METERED PATH WITH NO MEMORY FOR WHAT IT OWES IS REFUSED HERE, before a single credit
    // moves. The alternative is charging and then discovering, at the one moment it matters, that
    // the debt has nowhere to go — see {@link DraftFromMessageDeps.obligations}.
    if (deps.credits && !deps.obligations) {
      throw new ServiceError(
        "internal", 500,
        "AI drafting is metered on this deployment but no refund-obligation store was composed",
      );
    }
    // THE ADMISSION, before a credit moves: a spend taken with less than the least model time
    // left buys a call the platform kills, and a kill leaves no refund behind. Refused as the
    // retryable unavailable it is, with nothing charged.
    if (window !== null && Date.now() > window.admitUntil) {
      throw new ServiceError("ai_unavailable", 503, "AI drafting is temporarily unavailable; please retry");
    }
    const attemptKey = deps.credits ? this.debitKey(target.id, deps) : null;
    /** The attempt THIS request charged, or null. The port's `attempt` is the refund memory. */
    let chargedAttempt: string | null = null;
    /** The drafter's usage, carried by whichever release runs — a failed call's line included. */
    const usage = usageLines(this.opts.usageHost, ctx.accountId, "draft");
    let released = false;
    /**
     * THE ONE DOOR TO THE GATE'S RELEASE, once per request (`released` set before the await). A
     * reversal only for an attempt THIS request charged, and THE DEBT IS WRITTEN BEFORE THE
     * REVERSAL IS TRIED: this request is the only thing that knows a charge bought nothing, so an
     * unreachable program must still leave the debt behind. Idempotent per (account, attempt).
     * `null` when nothing was released: unmetered, or the door already used.
     */
    const releaseClaim = async (refund: boolean): Promise<ReleaseReceipt | null> => {
      if (!deps.credits || !attemptKey || released) return null;
      released = true;
      const meta = { messageId: target.id };
      if (!refund || chargedAttempt === null) {
        return deps.credits.release(
          ctx.accountId, { action: "draft", attemptKey, refund: false, meta, ...usage.field() });
      }
      await deps.obligations!.owe({
        accountId: ctx.accountId, action: "draft", attemptKey,
        attempt: chargedAttempt, reason: "drafter_failed", meta,
      });
      const receipt = await deps.credits.release(ctx.accountId, {
        action: "draft", attemptKey, refund: true, attempt: chargedAttempt, meta, ...usage.field(),
      });
      if (receipt === "settled") await deps.obligations!.settle(ctx.accountId, chargedAttempt);
      return receipt;
    };
    if (deps.credits && attemptKey) {
      const outcome = await deps.credits.spend(
        ctx.accountId, "draft", attemptKey, { messageId: target.id });
      chargedAttempt = outcome.verdict === "ok" ? outcome.attempt : null;
      if (outcome.verdict === "fault") {
        // A SERVER fault. 503, never 402 — we do not bill someone for our own outage, and we
        // do not tell them to buy credits they already have. Retryable, and the gate has
        // already reported the underlying error through `onError`. Through the shared refusal so
        // this one is on the record too: "the gate faulted" and "the subscription refused" were
        // indistinguishable in the logs, which is to say invisible.
        await refuseAiSpend(
          { refusal: "fault", verdict: outcome.verdict },
          {
            event: "draft_refused",
            accountId: ctx.accountId,
            unavailable: "AI drafting is temporarily unavailable; please retry",
          },
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
      result = await draftWithin(deps.drafter, input, window?.modelDeadline ?? null, usage.call);
    } catch (err) {
      // `refund: true` only for an attempt THIS request charged. A `duplicate` names an earlier
      // attempt whose work may have been delivered, and reversing that one because this request
      // failed would hand back a charge for a draft the customer already has.
      if (deps.credits && attemptKey) {
        if (chargedAttempt === null) {
          // Nothing moved, so nothing is owed: the claim goes back and the caller's own error
          // stands. A lost release here costs the customer nothing — the attempt stays open and
          // the retry is free.
          await releaseClaim(false);
          throw err;
        }
        const receipt = await releaseClaim(true);
        // AND THE PERSON IS TOLD WHICH OF THE TWO HAPPENED. Two states, two sentences, never one
        // optional field: `returned` is money already back, `owed` is money a pass will return.
        // The underlying error rides as `cause` — it is what the fault record and the log want —
        // but it may not be what reaches the person, because a 500 renders as "internal error"
        // and the one thing they need to know about their credits would be lost with it.
        throw new ServiceError(
          "ai_draft_failed", 503,
          receipt === "settled"
            ? "the draft could not be written; your credits are back"
            : "the draft could not be written; your credits will be returned",
          { credits: receipt === "settled" ? "returned" : "owed" },
          true,
        );
      }
      throw err;
    }

    // THE USAGE RELEASE, sent after the store below: the lesser fact. A plain release moves no money on this
    // action, so it carries the line and nothing else, and only while the release, the fault
    // record a timed-out one writes and the response all fit before the platform's kill. A skip
    // or a fault is a line in the log, never the person's error.
    const unrecorded = (why: string, err?: unknown): void => log.warn("draft_usage_unrecorded", {
      accountId: ctx.accountId, messageId: target.id, why, ...(err === undefined ? {} : { err }),
    });
    const sendUsage = async (): Promise<void> => {
      if (usage.count === 0 || !deps.credits || !attemptKey) return;
      const admission = this.opts.admission ?? DRAFT_ADMISSION;
      const tail = admission.spendCallCeilingMs + DRAFT_USAGE_RELEASE.faultRecordMs + DRAFT_USAGE_RELEASE.responseMarginMs;
      if (window !== null && Date.now() + tail > window.modelDeadline + admission.closeReserveMs) {
        unrecorded("no_time");
        return;
      }
      try {
        if ((await releaseClaim(false)) === "unreachable") unrecorded("unreachable");
      } catch (err) {
        // A release that threw is this log line, never the person's error.
        unrecorded("release_failed", err);
      }
    };

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
    let stored: Awaited<ReturnType<DraftsService["create"]>>;
    try {
      stored = await this.drafts.create(ctx, {
        mailboxId: target.mailboxId,
        threadId: target.threadId ?? null,
        inReplyToMessageId: target.id,
        subject: result.subject,
        ...(promoted.html ? { html: promoted.html } : { body: result.body }),
        rationale: result.rationale,
      }, { idempotency: deps.idempotency });
    } catch (err) {
      // The model call happened and was paid for; the store's own error is what the caller gets.
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
 * THE MODEL CALL, CUT AT THE DEADLINE. The drafter is handed the signal (the live client stops
 * retrying and waiting on it) AND raced against it here, so a drafter that ignores the signal
 * still cannot hold the request past the time the close was promised. A cut is a drafter failure:
 * the caller's catch takes its one door — the owed row, then the release with `refund: true`.
 */
async function draftWithin(
  drafter: DraftPort, input: DraftInput, deadline: number | null, call: AiCallOptions | undefined,
): Promise<Awaited<ReturnType<DraftPort["draft"]>>> {
  // The usage hook rides BOTH arms: an arm without it is a call nobody attributes.
  if (deadline === null) return call ? drafter.draft(input, call) : drafter.draft(input);
  const cut = (): ServiceError =>
    new ServiceError("ai_unavailable", 503, "the drafting model did not answer in time; please retry");
  const left = deadline - Date.now();
  if (left <= 0) throw cut();
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      drafter.draft(input, { ...call, signal: ac.signal }),
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
