import type { SpendAction } from "./ledger-source.js";
import type { AiRefusalReason } from "./ai-gate-port.js";
import type { Tx } from "./change-log.js";

/**
 * The entitlements port — the one question the open server asks about an account's standing, and
 * nothing that answers it. Metering belongs to whoever operates the service: a managed deployment
 * points `ENTITLEMENTS_URL` at a program holding that state; a self-hosted or desktop install has
 * none and is unmetered. Both run the same route table, so callers must name the answer without
 * depending on what answers. On the MAIL barrel — pure types, no database — because every host
 * compiles the route table and the engine artifact may not carry the hosted half; the two answers
 * live on the hosted barrel. The shapes follow wire contract v1 and only ever REDUCE it: the
 * program answers ten `reason` values, this port carries two.
 */

/** Why access was refused. Two states, because a refusal has two remedies: pay, or ask us. */
export type AccessRefusal = "payment_required" | "suspended";

/** The lifecycle's closed state set — wire contract v1's `lifecycle.state` (2026-09-20). */
export type AccessLifecycleState =
  | "trialing" | "grace" | "past_due" | "active" | "closed" | "erased";

/** Why a closed account closed. `null` on a closed state means "nothing to depart from". */
export type AccessClosedReason = "trial_ended" | "canceled" | "unpaid" | "suspended";

/**
 * The program's `lifecycle` block, carried VERBATIM (ISO strings, not Dates): every consumer is a
 * renderer or a comparator, and parsing dates here would put a timezone decision in a port.
 * Absent on the wire = an old program = today's behaviour, so the field below is optional on both
 * verdict arms — `grace`/`past_due` ride `ok: true`, `closed`/`erased` ride the refusal.
 */
export interface AccessLifecycle {
  state: AccessLifecycleState;
  closedReason: AccessClosedReason | null;
  /** The trial period's end, while `trialing` only — the day-12 mail and the banner's date. */
  trialEndsAt: string | null;
  /** The open-until deadline: dunning's 7 d, or cancel + 24 h for a never-paid cancel. */
  graceUntil: string | null;
  closedAt: string | null;
  /** `max(closedAt, lifecycleEpoch)` + retention (30 d never-paid / 90 d paid); null if held. */
  erasureAt: string | null;
  erasedAt: string | null;
  formerlyPaid: boolean;
  /**
   * The instant the program's own lifecycle went live, which `erasureAt` is floored on there.
   * ABSENT (or null) means the program states none — an older program, and the erasure pass then
   * erases nothing. Present, it is what that pass belts an irreversible act against.
   */
  lifecycleEpoch?: string | null;
}

/**
 * What one action of each call site costs, in credits — the card the program states on
 * `/v1/access`. Carried, never held: this tree has no price of its own.
 */
export type ActionPrices = Record<SpendAction, number>;

/** May this account use the service, and within what limits. `prices` absent = unpriced. */
export type AccessVerdict =
  | { ok: true; limits: AccessLimits; lifecycle?: AccessLifecycle; prices?: ActionPrices }
  | { ok: false; reason: AccessRefusal; manageUrl?: string; lifecycle?: AccessLifecycle };

/**
 * `null` means UNBOUNDED, never unknown: a fault answers with the last known verdict and defaults
 * to allow, so there is no third state to carry.
 *
 * `canAddMailbox` and `aiEnabled` are separate questions and not derivable from the numbers —
 * an account may retain the mailboxes it has and be forbidden another, and one that has switched
 * AI off is healthy. Collapsing them is how a refusal ends up offering a plan the customer holds.
 */
export interface AccessLimits {
  mailboxes: number | null;
  storageBytes: number | null;
  canAddMailbox: boolean;
  aiEnabled: boolean;
}

/**
 * The money answer for one AI action — five verdicts the program states, plus the one the CALLER
 * synthesizes. Each of the two extras is a defect if folded: `refused` folded into `insufficient`
 * answers "out of credits" to a funded account whose owner switched AI off — a payment demand for
 * the product working as asked (409, never 402); `inflight` folded into `duplicate` tells the
 * loser of a race to PROCEED, buying a second paid model call for one credit — it is the
 * exclusive claim's whole purpose, per-SOURCE so a batch moves on. `fault` is never a 200 body:
 * it is what a caller says when the program could not answer, which keeps a fault impossible to
 * mistake for a refusal.
 */
export type SpendOutcome =
  /** Proceed; this attempt moved money. KEEP `attempt` — it is what a reversal names. */
  | { verdict: "ok"; charged: true; attempt: string }
  /** Proceed, free: an attempt for this work is already open and paid for. */
  | { verdict: "duplicate"; charged: false; attempt: string }
  /** The plan could spend and the balance is empty. A payment demand. */
  | { verdict: "insufficient"; reason: AiRefusalReason }
  /** The subscription or the account's own switch may not spend. NOT a payment demand. */
  | { verdict: "refused"; reason: AiRefusalReason }
  /** Another caller holds the claim on this exact work. Transient, never charged, do not proceed. */
  | { verdict: "inflight"; source: string }
  /** We do not know. Degrade — never a charge and never a demand. */
  | { verdict: "fault" };

/**
 * WHICH CALL SITE IS SPENDING — the terms table's own keys, and not a second list of them.
 *
 * It was a hand-written union of the same five words. One definition, because the terms
 * (`SPEND_ACTIONS`: reason, namespace, exclusivity, pool, retry window) and the names have to
 * move together — a sixth action added to the table with no word here, or a word here with no
 * terms, is what a port cannot express.
 */
export type { SpendAction } from "./ledger-source.js";

/**
 * How a spend ended — `refund: false` gives the claim back, `true` also reverses the charge. A
 * UNION, and the asymmetry is deliberate: a reversal must NAME the attempt it reverses, and a
 * release that reverses nothing has nothing to name. As one shape with an optional `attempt`,
 * "refund this, I forget which attempt" is representable — and that shape reverses a NEIGHBOUR'S
 * charge, because the gate falls back to the bare source, which is attempt 1 and may belong to
 * work delivered months ago. Pass `refund: true` only with an `attempt` THIS caller was told was
 * `charged: true`, once per abandonment. A `duplicate` charged nothing; its caller releases and
 * does not refund.
 */
export type SpendRelease = {
  action: SpendAction;
  attemptKey: string;
  /** Provenance for the reversal's own ledger row. Ids and counts, never a message's content. */
  meta?: SpendMeta;
  /** The model calls this work made, when the host records usage: at most
   *  {@link AI_USAGE_LINES_PER_RELEASE}, each naming this release's account. */
  usage?: readonly AiUsageLine[];
} & (
  | { refund: false }
  | {
      refund: true;
      /** What {@link SpendOutcome} returned as `attempt` for a `charged: true` answer. */
      attempt: string;
    }
);

/**
 * DID THE PROGRAM TAKE THIS RELEASE — the answer that makes a lost refund writable.
 *
 * `release` answered `void`, so a reversal the program never received and one it applied were the
 * same value at every call site. A spend that bought nothing then had no way to become an
 * obligation and no way to tell the person which of the two happened to their credits. Two
 * members, never an optional field: "we do not know" is `unreachable` here, because a refund we
 * cannot confirm is a debt until something confirms it.
 */
export type ReleaseReceipt =
  /** The program answered 200. The claim is back, and a refund named here is reversed. */
  | "settled"
  /** Nothing answered, or the answer was not a 200. Whatever this release owed is still owed. */
  | "unreachable";

/**
 * PROVENANCE FOR THE LEDGER ROW, and the reason it is not free-form in practice.
 *
 * It is a `jsonb` column and indexes nothing, which is why identifiers too long or too variable
 * for a source belong here — the mailbox, the message, the run and its step. It is also the
 * column a privacy review found carrying a raw `Message-ID`, so what goes in are ids WE minted
 * and counts, and nothing a sender chose.
 */
export type SpendMeta = Record<string, unknown>;

/** Which host made a model call. */
export type AiUsageHost = "api" | "worker" | "server";

/**
 * ONE MODEL CALL'S USAGE, as the entitlements program is told it: ids and counts, never content.
 * The account and the action are the caller's; the counts are the model client's report. No
 * request id (it stays in the host's `ai_call` log line) and no cost: the program prices the
 * tokens itself, so no estimate made here is a figure it has to trust.
 */
export interface AiUsageLine {
  accountId: string;
  action: SpendAction;
  host: AiUsageHost;
  model: string;
  /** When the call ended, ISO 8601. */
  at: string;
  ok: boolean;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** A breakdown of `outputTokens`, never counted on top of it. */
  thinkingTokens: number | null;
}

/** The most lines one release carries: one work item's calls, never a batch. */
export const AI_USAGE_LINES_PER_RELEASE = 8;
/** The most lines one `recordUsage` call carries. */
export const AI_USAGE_LINES_PER_POST = 500;

/** The report fields a line copies. Structural, so this file names nothing in the model client. */
export type AiUsageCounts = Pick<AiUsageLine,
  "model" | "ok" | "attempts" | "inputTokens" | "outputTokens" | "cacheReadTokens"
  | "cacheWriteTokens" | "thinkingTokens">;

/** One line from one report. Copies the counts and nothing else: a report's request id and cost
 *  estimate stay behind. */
export function aiUsageLineOf(
  report: AiUsageCounts,
  who: { accountId: string; action: SpendAction; host: AiUsageHost },
  at: Date = new Date(),
): AiUsageLine {
  return {
    accountId: who.accountId, action: who.action, host: who.host, model: report.model,
    at: at.toISOString(), ok: report.ok, attempts: report.attempts,
    inputTokens: report.inputTokens, outputTokens: report.outputTokens,
    cacheReadTokens: report.cacheReadTokens, cacheWriteTokens: report.cacheWriteTokens,
    thinkingTokens: report.thinkingTokens,
  };
}

/**
 * What `recordUsage` answers. `refused` is the program answering a 4xx, `no_door` its 404 (an
 * older program without `/v1/usage`, which no retry will change) and `unreachable` no answer at
 * all. Each drops the batch; they are said apart so a refusal is never logged as an outage.
 */
export type UsageReceipt = "settled" | "refused" | "no_door" | "unreachable";

/** Why a spend bought nothing. The `credit_refund_obligations_reason_check` set, as words. */
export type RefundObligationReason =
  /** The model call this spend paid for threw. Nothing was produced and nothing was stored. */
  | "drafter_failed"
  /** Advice was bought for a mailbox no organizer can apply it to — bought, then unusable. */
  | "no_organizer"
  /** The sender was advised between the candidate query and the claim: the spend bought a second
   *  copy of an answer that already exists. */
  | "already_advised";

/** One debt: everything the reversal needs, and nothing about what a credit is worth. */
export interface RefundObligation {
  accountId: string;
  action: SpendAction;
  /** The BARE attempt key. The port composes the ledger source; storing a composed one
   *  double-prefixes it on the drain's release. */
  attemptKey: string;
  /** What {@link SpendOutcome} answered as `attempt` for a `charged: true` verdict. */
  attempt: string;
  reason: RefundObligationReason;
  meta?: SpendMeta;
}

/**
 * WHERE A SPEND THAT BOUGHT NOTHING IS REMEMBERED — a port, for the reason `ApiFaultLogPort` is
 * one: the table is Cloud's and this file is on the mail barrel, which the desktop engine
 * compiles. A local install composes none of this and has nothing to owe.
 *
 * `owe` runs BEFORE the reversal is attempted, so a crash between the two leaves the debt
 * standing; it is idempotent per (account, attempt), so observing one failure twice is one debt.
 * `settle` is what a receipt of `settled` earns. Neither may throw for anything but a real write
 * failure: a lost obligation is the defect this port exists to close, so it is never swallowed.
 */
export interface RefundObligationPort {
  owe(o: RefundObligation): Promise<void>;
  settle(accountId: string, attempt: string): Promise<void>;
}

/**
 * What erasure learned when it stopped the money — the erasure response's own three values, so
 * nothing translates between them and none of them can be reported as another.
 */
export type ReleaseOutcome = "none" | "cancelled" | "cancel_failed";

/**
 * What the program said about a Checkout the person has just returned from. `confirmed`: it is
 * this account's, paid and applied, so access reads open. `pending`: not yet — keep asking access.
 * `not_found`: an unknown session, another account's, or a program without the door. `fault`: no
 * answer. Four words, so an outage is never read as "not yours".
 */
export type ReturnConfirmOutcome = "confirmed" | "pending" | "not_found" | "fault";

/**
 * How a read of `access` may be answered. `fresh` asks past every cache and hold; `staleAllow` is
 * a READ route's: an ALLOW held a little past its TTL answers at once and is re-read behind it,
 * and a held refusal is asked about again first. `askedAfter` (the client's clock) answers only
 * from a call begun at or after that instant — no older held verdict, no older call in flight, and
 * on a fault no older verdict either. One of the three, never two.
 */
export type AccessReadOpts =
  | { fresh?: boolean; staleAllow?: never; askedAfter?: never }
  | { staleAllow: true; fresh?: never; askedAfter?: never }
  | { askedAfter: number; fresh?: never; staleAllow?: never };

export interface EntitlementsPort {
  /**
   * NEVER THROWS: a transport fault answers with the last verdict this process saw for the
   * account, or with none `ok: true` and unbounded limits. An entitlements outage must not lock
   * a paying customer out of their mail, which is also why implementations cache.
   *
   * `fresh: true` skips the held verdict and asks again — for a caller that must not read a
   * cached refusal (the wall, the AI refusal cross-check), because a held refusal outlives the
   * condition that produced it. Never on the mail path: a per-request dial there is the thing
   * the cache exists to prevent. A read joins a call for the account already in flight.
   */
  access(accountId: string, opts?: AccessReadOpts): Promise<AccessVerdict>;
  /**
   * A fresh read that says when it could not ask: the verdict of an answer, or `"fault"` where
   * `access` would answer the last verdict it knew. For a door that acts irreversibly on the
   * answer (erasure), where a remembered verdict is not evidence. Never throws on a fault.
   */
  accessOrFault(accountId: string): Promise<AccessVerdict | "fault">;
  /**
   * How many `access` dials this process made that the program did not answer, ever. A bounded
   * reader reads it before and after a round to stop asking a program that is not answering;
   * a port without it is judged by its `UNMETERED_ACCESS` answers alone.
   */
  accessFaults?(): number;
  /**
   * Charge one AI action against `attemptKey`, which names the unit of WORK so retries are free.
   * `attemptKey` is the BARE key — the message, `<messageId>:<hashed client key>`, the run id —
   * never a composed ledger source. Both implementations compose the source through the one
   * composer (`sourceFor`), which refuses a key that is already a source: a double-prefixed one
   * passes the ledger's namespace CHECK and its UNIQUE, so already-paid work would answer `ok`
   * and be charged twice. Build keys with `ledger-source.ts`. Never answers a money verdict by
   * throwing — see {@link SpendOutcome}; a malformed key is the caller-bug class and raises.
   */
  spend(
    accountId: string, action: SpendAction, attemptKey: string, meta?: SpendMeta,
  ): Promise<SpendOutcome>;
  /**
   * The work is over, whichever way it ended. Never throws; replay-safe, and it ANSWERS — see
   * {@link ReleaseReceipt}. A caller reversing a charge reads the receipt and records what the
   * program did not take; a caller merely handing a claim back may ignore it, because a lost
   * release costs the customer nothing (the attempt stays open, so the retry is free).
   */
  release(accountId: string, r: SpendRelease): Promise<ReleaseReceipt>;
  /**
   * Usage of model calls no release carries (ingest classification, workflow steps), at most
   * {@link AI_USAGE_LINES_PER_POST} lines. Delivered at most once: a caller logs a refused batch
   * and drops it, so the record under-counts and never over-counts. OPTIONAL: an older program
   * and an unmetered host record nothing. Never throws.
   */
  recordUsage?(lines: readonly AiUsageLine[]): Promise<UsageReceipt>;
  /**
   * The one customer-facing door the managed service has: plan choice for an account with no
   * subscription, and plan status for one that has. A KNOWN account always gets a URL, so this is
   * also the only route to a FIRST subscription — which is why `null` means one thing, that the
   * program does not know this account, and not "nothing to manage".
   *
   * Render the row, or the onboarding link, only when a URL comes back; never store one. `lang`
   * is the page's language; absent, the page picks its own.
   */
  manageLink(accountId: string, lang?: "de" | "en"): Promise<{ url: string } | null>;
  /** The person is being erased: stop the money. Bounded and never throwing, because Article 17
   *  may not be withheld because a payment processor is unreachable. */
  releaseAccount(accountId: string): Promise<ReleaseOutcome>;
  /**
   * Ask the program to apply a Checkout the person has just returned from, instead of waiting for
   * its webhook. `sessionId` is relayed as the return URL carried it; the program checks it names
   * THIS account. Grants no credits here — the answer is relayed and access is read fresh after.
   * Never throws. Optional: a program without the door answers `not_found` at the route.
   */
  confirmReturn?(accountId: string, sessionId: string): Promise<ReturnConfirmOutcome>;
}

/**
 * WHAT A HOST WITH NO ENTITLEMENTS PROGRAM SAYS — a named state, never an absent field.
 *
 * Absent is a composition nobody finished; this literal is a deployment that means it. Every
 * composition fills the member, with a port or with this, so a bag holding neither is a
 * configuration error rather than a silently free tier.
 */
export const UNMETERED = "unmetered" as const;

/** A composition either reaches an entitlements program or declares itself unmetered. */
export type EntitlementsComposition = EntitlementsPort | typeof UNMETERED;

/**
 * THE SPEND HALF ALONE — what an AI call site is handed.
 *
 * A call site asks about money and says when the work ended; it has no business reading limits,
 * minting a manage link or cancelling a subscription. Narrowing it here rather than at each site
 * means the ten of them name one type, and a test double is two methods rather than five.
 */
export type SpendPort = Pick<EntitlementsPort, "spend" | "release">;

/**
 * THE ACCESS HALF ALONE — what a call site is handed when it must ask "may this account use AI
 * at all", and nothing else.
 *
 * Narrow for {@link SpendPort}'s reason and one of its own: the sites that read it are refusal
 * paths, and a refusal path holding `spend` could charge while explaining why it will not.
 */
export type AccessPort = Pick<EntitlementsPort, "access">;

/** A call site either reaches an entitlements program or is told this host meters nothing. */
export type SpendComposition = SpendPort | typeof UNMETERED;

/** True iff this host meters spend at all. The unmetered arm charges nothing and asks nobody. */
export function isSpendMetered(e: SpendComposition): e is SpendPort {
  return e !== UNMETERED;
}

/** The unmetered verdict as a value — unbounded limits, AI gated only by a provider key. */
export const UNMETERED_ACCESS: AccessVerdict = {
  ok: true,
  limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true },
};

/** Read access through whatever this host declared. The unmetered arm dials nothing, which is what
 *  makes an unmetered install unable to depend on a network answer. */
export async function accessOf(
  entitlements: EntitlementsComposition, accountId: string, opts?: AccessReadOpts,
): Promise<AccessVerdict> {
  if (entitlements === UNMETERED) return UNMETERED_ACCESS;
  return entitlements.access(accountId, opts);
}

/** True iff this host reaches an entitlements program at all. */
export function isMetered(e: EntitlementsComposition): e is EntitlementsPort {
  return e !== UNMETERED;
}

/**
 * Which of these accounts are PARKED — the one answer both the worker's roster and every alert
 * pass read, so the roster and the pager cannot disagree about who is on duty. `ok: false` is
 * parked. `null` on an unmetered host: nobody parks there, and the caller says so explicitly.
 * The client never throws and a fault answers last-known/allow, so a faulting read syncs more.
 */
export type ParkedAccountsReader = (
  accountIds: readonly string[], now: Date,
  /** Accounts whose refusal must be asked again from `since` (the client's clock) — see below. */
  recheck?: { accounts: ReadonlySet<string>; since: number },
) => Promise<Set<string>>;

/** Bounded fan-out: one `access` per account, eight at a time. */
export const PARKED_READ_CONCURRENCY = 8;

/**
 * One account at or over its storage cap, as the storage rule reads it: counted stored-body bytes
 * beside the cap the entitlements program states.
 */
export interface AtCapAccount {
  accountId: string;
  bytes: number;
  storageBytesLimit: number;
}

/**
 * WHO IS AT THEIR STORAGE CAP, AS A READING — the at-cap accounts among those read, how many were
 * read, and how many hold stored mail. `read < total` is a partial reading and is said as one: an
 * account past the bound, or one whose cap could not be asked, is not read, never "under its cap".
 */
export interface AtCapReading {
  atCap: readonly AtCapAccount[];
  read: number;
  total: number;
}

/** Reads the at-cap population through the pass's own handle; the hosted barrel builds one. */
export type AccountsAtCapReader = (db: Tx, now: Date) => Promise<AtCapReading>;

/**
 * A plane read's own bound: no round starts past `boundMs`, a round still out at it is abandoned,
 * and no round starts once the dials this read caused have faulted `faultCeiling` times. So a
 * program that hangs costs the caller `boundMs`, and one that fails fast costs a round of rows.
 */
export interface PlaneReadBound {
  boundMs: number;
  faultCeiling: number;
}

const ROUND_TIMED_OUT = Symbol("round timed out");

/** Resolves `p`, or `ROUND_TIMED_OUT` after `ms`; the timer never outlives the answer. */
async function within<V>(p: Promise<V>, ms: number): Promise<V | typeof ROUND_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof ROUND_TIMED_OUT>((res) => { timer = setTimeout(() => res(ROUND_TIMED_OUT), Math.max(0, ms)); });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `ask` for every item, {@link PARKED_READ_CONCURRENCY} at a time. Without a bound every item is
 * answered; with one, `complete` is false when the bound stopped it, and `answered` holds only
 * the rounds that finished.
 */
export async function inPlaneRounds<T>(
  entitlements: EntitlementsPort, items: readonly T[], ask: (item: T) => Promise<AccessVerdict>,
  bound?: PlaneReadBound,
): Promise<{ answered: Array<[T, AccessVerdict]>; complete: boolean }> {
  const deadline = bound ? Date.now() + bound.boundMs : Infinity;
  const base = entitlements.accessFaults?.();
  let unanswered = 0;
  const answered: Array<[T, AccessVerdict]> = [];
  for (let i = 0; i < items.length; i += PARKED_READ_CONCURRENCY) {
    if (bound) {
      const faults = base === undefined ? unanswered : entitlements.accessFaults!() - base;
      if (faults >= bound.faultCeiling || Date.now() >= deadline) return { answered, complete: false };
    }
    const chunk = items.slice(i, i + PARKED_READ_CONCURRENCY);
    const round = Promise.all(chunk.map(ask));
    round.catch(() => undefined);
    const verdicts = bound ? await within(round, deadline - Date.now()) : await round;
    if (verdicts === ROUND_TIMED_OUT) return { answered, complete: false };
    chunk.forEach((item, j) => {
      const v = verdicts[j]!;
      if (v === UNMETERED_ACCESS) unanswered++;
      answered.push([item, v]);
    });
  }
  return { answered, complete: true };
}

/** A bounded parked read that did not finish: which accounts are parked is not known. */
export class ParkedReadUnfinished extends Error {
  constructor(readonly read: number, readonly total: number) {
    super(`parked read stopped at its bound: ${read} of ${total} accounts read`);
    this.name = "ParkedReadUnfinished";
  }
}

export function parkedAccountsOf(
  entitlements: EntitlementsComposition, bound?: PlaneReadBound,
): ParkedAccountsReader | null {
  if (!isMetered(entitlements)) return null;
  return async (accountIds, _now, recheck) => {
    /* A REFUSAL IS ASKED AGAIN FOR A RECHECKED ACCOUNT (mail 0135): its row was kicked, and the
       reopening door kicks in the statement that clears the block, so a refusal held from before
       the kick may predate the clear. Only a refusal is asked twice; an allow stands. */
    const { answered, complete } = await inPlaneRounds(entitlements, accountIds, async (id) => {
      const held = await entitlements.access(id);
      return held.ok || !recheck?.accounts.has(id)
        ? held
        : entitlements.access(id, { askedAfter: recheck.since });
    }, bound);
    // A partial parked set would call every unread account on duty, so an unfinished read throws.
    if (!complete) throw new ParkedReadUnfinished(answered.length, accountIds.length);
    return new Set(answered.filter(([, v]) => !v.ok).map(([id]) => id));
  };
}

/**
 * WHAT ONE ACTION COSTS, IN CREDITS — asked, never held. The program that mints the debit states
 * its card on `/v1/access`; a quote is read from that answer so a person sees the figure before
 * anything is spent. `null` means this host states no price: an unmetered host charges nothing,
 * and a metered one with no card withholds the quote and sells nothing.
 */
export interface ActionPricing {
  priceOf(accountId: string, action: SpendAction): Promise<number | null>;
}

/** The null default: the action is recorded and nothing is priced. */
export const UNPRICED: ActionPricing = { priceOf: async () => null };

/** The card this host's access answer carries. An unmetered host prices nothing. */
export function pricingOf(entitlements: AccessPort | typeof UNMETERED): ActionPricing {
  if (entitlements === UNMETERED) return UNPRICED;
  return {
    async priceOf(accountId, action) {
      const verdict = await entitlements.access(accountId);
      return verdict.ok ? verdict.prices?.[action] ?? null : null;
    },
  };
}

/** `/health`'s reading of where prices come from: the program's card, none yet, or no meter. */
export type AiPricingMarker = "plane" | "unpriced" | "unmetered";
