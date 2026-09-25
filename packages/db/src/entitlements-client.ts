import {
  UNMETERED_ACCESS,
  type AccessLifecycle, type AccessLifecycleState, type AccessClosedReason, type ActionPrices,
  type AccessReadOpts, type AccessRefusal, type AccessVerdict, type EntitlementsPort,
  type ReleaseOutcome, type ReleaseReceipt, type SpendAction, type SpendMeta, type SpendOutcome,
  type SpendRelease,
} from "./entitlements-port.js";
import { isAiRefusalReason } from "./ai-gate-port.js";
import { SPEND_ACTIONS, assertAttemptKey } from "./ledger-source.js";

/**
 * The HTTP client of an entitlements program, implementing {@link EntitlementsPort} over that
 * program's wire contract v1. An operator who runs their own points `ENTITLEMENTS_URL` at it; a
 * host that sets nothing constructs none and is unmetered. The fault arm is the load-bearing
 * line: `access` sits on the mail path, so an unreachable program must not lock a paying customer
 * out of their own mail — a fault answers with the last verdict this process saw, and with none,
 * allow; refuse-when-unsure turns one outage into every inbox going dark. And a 200 nobody can
 * parse is a FAULT, not an allow — that would be silent unmetering: an unrecognised 200 is
 * reported by name with the offending field and then takes the fault path.
 */

/**
 * THE BUDGET ON EVERY CALL, AND ITS ORIGIN — a stated budget, not a ceiling somebody liked.
 * Measured 2026-09-13 with the program beside its own database: `/v1/access` p50 0.34 s, max
 * 0.39 s, p95 291 ms in production. Five seconds is about twelve times that, and no more, because
 * `screener-service.ts` subtracts it from the admission window. The 3 000 ms it replaces was the
 * program's OWN p50 across an ocean: it fired on each spend, the verdict read `fault`, the route
 * answered 503 — and the program completed that spend seconds later and CHARGED for it. One
 * number for every path, because no path is slow now.
 */
export const ENTITLEMENTS_CALL_BUDGET_MS = 5_000;

/** The program's paths — a closed union, so `post` cannot be sent one nobody has priced. */
export type EntitlementsPath =
  | "/v1/access" | "/v1/spend" | "/v1/spend/release" | "/v1/manage-link" | "/v1/account/release";

/** How long an `access` verdict is reused before it is re-read. */
export const ACCESS_TTL_MS = 60_000;

/**
 * How long a FAILED access read answers for its account before this process asks again: one
 * call budget. On 2026-09-25 the program finished a timed-out burst 5.2-6.1 s after it began, so
 * a call one budget after the timeout lands behind that backlog, not in it. The held answer is
 * the fault arm's own (last verdict, else allow); `fresh` reads are never held.
 */
export const ACCESS_FAULT_HOLD_MS = ENTITLEMENTS_CALL_BUDGET_MS;

/**
 * How old a held ALLOW a READ route may answer on while it is re-read behind it: ten minutes. A
 * read route writes and spends nothing, and the refresh it starts is the answer every later
 * request reads, so a refusal reaches the next one. A longer gap is a new session, and its first
 * read asks first, so an account that moved meets the wall at once. On 2026-09-25 the first read
 * after the 60 s TTL waited ~500 ms on the program; a held refusal is never served this way.
 */
export const ACCESS_STALE_ALLOW_MS = 10 * 60_000;

/**
 * The account `/health` asks about when no real access read has carried the price card yet. The
 * nil uuid names nobody, and the program's answer for an unknown account writes nothing (no
 * manage link is minted for it), so the probe reads the card and moves no state.
 */
export const PRICE_PROBE_ACCOUNT = "00000000-0000-0000-0000-000000000000";

/** How long `/health` waits for that probe. Past it the reading is `unpriced`, never a stall. */
export const PRICE_PROBE_BUDGET_MS = 1_500;

/** The client, plus the one reading `/health` publishes about it. */
export type EntitlementsClient = EntitlementsPort & {
  /** `plane` once any access answer carried a readable card, else `unpriced`. Never throws. */
  aiPricing(): Promise<"plane" | "unpriced">;
};

/** The slice of `fetch` this client needs — injectable so no test opens a socket. */
export type EntitlementsFetch = (url: string, init: {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ status: number; json(): Promise<unknown> }>;

/** A drift between the two sides, named. `field` is what could not be read, never a value. */
export interface ContractFault {
  path: string;
  status: number;
  /** The field that failed to parse, or `"body"` when the whole shape was wrong. */
  field: string;
}

/**
 * A CALL THE PROGRAM DID NOT ANSWER 200 TO — the outage half, beside {@link ContractFault}'s
 * drift half. `status` is null when nothing arrived inside the budget. Never a body, never an
 * account: an outage is every account at once, and one more identifier in a log answers nothing.
 */
export interface CallFault {
  path: string;
  status: number | null;
  elapsedMs: number;
  /** What bounded it, so a reader can tell a slow program from a refusing one. */
  budgetMs: number;
}

export interface EntitlementsClientConfig {
  /** `ENTITLEMENTS_URL` — the program's origin. A trailing slash is normalized. */
  baseUrl: string;
  /** `BILLING_PLANE_SECRET` — the program's own bearer, presented on every call. */
  secret: string;
  /** Production leaves this absent (global `fetch`); every test injects one. */
  fetchImpl?: EntitlementsFetch;
  /** Test-only, per path. Production states nothing and takes the measured budgets above. */
  budgetsMs?: Partial<Record<EntitlementsPath, number>>;
  ttlMs?: number;
  now?: () => number;
  /**
   * Where a contract drift goes. Absent ⇒ `console.warn`. A client that degraded silently is one
   * nobody can debug when "metering stopped applying" arrives as a finance question.
   */
  onContractFault?: (f: ContractFault) => void;
  /**
   * Where an outage goes. Absent ⇒ `console.warn`. Until this existed the fault arm was SILENT:
   * a program too slow to answer produced a 503 per press and not one line saying why.
   *
   * AWAITED, because a host that writes a row here is serverless and is killed the moment it
   * answers — a floating promise would record nothing on the one platform the row exists for.
   * It may not throw; if it does, the answer is unchanged and the report is dropped.
   */
  onCallFault?: (f: CallFault) => void | Promise<void>;
}

/** One completed exchange, or the fact that there was not one. */
interface Exchange {
  status: number;
  body: unknown;
  bodyIsJson: boolean;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  (typeof v === "object" && v !== null && !Array.isArray(v)) ? v as Record<string, unknown> : null;

/** The program's ten reasons, reduced to the two sentences the open app has. */
function refusalOf(reason: unknown): AccessRefusal {
  return reason === "suspended" ? "suspended" : "payment_required";
}

const LIFECYCLE_STATES: ReadonlySet<string> =
  new Set<AccessLifecycleState>(["trialing", "grace", "past_due", "active", "closed", "erased"]);
const CLOSED_REASONS: ReadonlySet<string> =
  new Set<AccessClosedReason>(["trial_ended", "canceled", "unpaid", "suspended"]);

/**
 * The `lifecycle` block, or `null` for an old program that sends none (= today's behaviour), or
 * the field that could not be read. Two refusals are the contract's own: an unknown `state` (a
 * word no surface here has a sentence for), and `closed`/`erased` beside `syncEnabled: true` —
 * the one property the joint truth table pins, so a body breaking it is a drift between the two
 * programs, never a verdict. Both go through the EXISTING fault arm: last verdict else allow,
 * NEVER a lockout invented from a drift.
 */
function lifecycleOf(raw: unknown, syncEnabled: boolean): AccessLifecycle | null | { bad: string } {
  if (raw === undefined || raw === null) return null;
  const l = obj(raw);
  if (!l) return { bad: "lifecycle" };
  if (typeof l.state !== "string" || !LIFECYCLE_STATES.has(l.state)) return { bad: "lifecycle.state" };
  if ((l.state === "closed" || l.state === "erased") && syncEnabled) return { bad: "lifecycle.state" };
  const reason = l.closedReason ?? null;
  if (reason !== null && (typeof reason !== "string" || !CLOSED_REASONS.has(reason))) {
    return { bad: "lifecycle.closedReason" };
  }
  if (typeof l.formerlyPaid !== "boolean") return { bad: "lifecycle.formerlyPaid" };
  const iso = (field: string): string | null | { bad: string } => {
    const v = l[field] ?? null;
    return v === null || typeof v === "string" ? v : { bad: `lifecycle.${field}` };
  };
  const read: Partial<Record<
    "trialEndsAt" | "graceUntil" | "closedAt" | "erasureAt" | "erasedAt" | "lifecycleEpoch",
    string | null
  >> = {};
  for (const field of [
    "trialEndsAt", "graceUntil", "closedAt", "erasureAt", "erasedAt", "lifecycleEpoch",
  ] as const) {
    const v = iso(field);
    if (typeof v === "object" && v !== null) return v;
    read[field] = v;
  }
  return {
    state: l.state as AccessLifecycleState,
    closedReason: (reason as AccessClosedReason | null),
    trialEndsAt: read.trialEndsAt ?? null,
    graceUntil: read.graceUntil ?? null,
    closedAt: read.closedAt ?? null,
    erasureAt: read.erasureAt ?? null,
    erasedAt: read.erasedAt ?? null,
    formerlyPaid: l.formerlyPaid,
    // The program's erasure floor. A program that sends none states none: the field is dropped
    // rather than carried as a null, so "absent" reads the same here as it does on the wire.
    ...(read.lifecycleEpoch != null ? { lifecycleEpoch: read.lifecycleEpoch } : {}),
  };
}

/**
 * THE `access` ANSWER — the full entitlement, from which the open side derives what it needs.
 * The refusal is `syncEnabled === false`: the program deliberately does not send an ok/refused
 * pair, because `reason`, `syncEnabled` and `canAddMailbox` are three different questions.
 *
 * Returns the field that failed when it cannot read one, so the drift is nameable.
 */
function verdictOf(body: unknown): AccessVerdict | { bad: string } {
  const b = obj(body);
  if (!b) return { bad: "body" };
  const e = obj(b.entitlements);
  if (!e) return { bad: "entitlements" };
  if (typeof e.syncEnabled !== "boolean") return { bad: "entitlements.syncEnabled" };
  if (typeof e.canAddMailbox !== "boolean") return { bad: "entitlements.canAddMailbox" };
  if (typeof e.aiEnabled !== "boolean") return { bad: "entitlements.aiEnabled" };

  // The lifecycle rides BOTH arms below, so it is read before either returns; a block that
  // cannot be read refuses the WHOLE body — reading the verdict while dropping the block would
  // hand a locked screen no dates to render, silently.
  const lifecycle = lifecycleOf(b.lifecycle, e.syncEnabled);
  if (lifecycle !== null && "bad" in lifecycle) return lifecycle;

  const url = typeof b.manageUrl === "string" && b.manageUrl.length > 0 ? b.manageUrl : undefined;
  if (!e.syncEnabled) {
    return {
      ok: false, reason: refusalOf(e.reason),
      ...(url ? { manageUrl: url } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    };
  }
  const num = (v: unknown, field: string): number | null | { bad: string } =>
    v === null ? null : typeof v === "number" ? v : { bad: field };
  const mailboxes = num(e.mailboxLimit, "entitlements.mailboxLimit");
  if (typeof mailboxes === "object" && mailboxes !== null) return mailboxes;
  const storageBytes = num(e.storageBytesLimit, "entitlements.storageBytesLimit");
  if (typeof storageBytes === "object" && storageBytes !== null) return storageBytes;
  return {
    ok: true,
    limits: {
      mailboxes, storageBytes, canAddMailbox: e.canAddMailbox, aiEnabled: e.aiEnabled,
    },
    ...(lifecycle ? { lifecycle } : {}),
  };
}

/**
 * The `prices` block: every call site this client spends on, each a non-negative integer.
 * Absent or null is an older program — unpriced, not a drift. A block that is there and cannot
 * be read is a drift, named, and reads as unpriced: a price nobody can read sells nothing, and it
 * must never cost the account its access verdict.
 */
function pricesOf(raw: unknown): ActionPrices | null | { bad: string } {
  if (raw === undefined || raw === null) return null;
  const p = obj(raw);
  if (!p) return { bad: "prices" };
  const card = {} as ActionPrices;
  for (const action of Object.keys(SPEND_ACTIONS) as (keyof ActionPrices)[]) {
    const v = p[action];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return { bad: `prices.${action}` };
    card[action] = v;
  }
  return card;
}

/** The program's five spend verdicts. `fault` is never one of them — see {@link SpendOutcome}. */
function spendOf(body: unknown): SpendOutcome | { bad: string } {
  const b = obj(body);
  if (!b) return { bad: "body" };
  switch (b.verdict) {
    case "ok":
    case "duplicate": {
      if (typeof b.attempt !== "string" || b.attempt.length === 0) return { bad: "attempt" };
      return b.verdict === "ok"
        ? { verdict: "ok", charged: true, attempt: b.attempt }
        : { verdict: "duplicate", charged: false, attempt: b.attempt };
    }
    case "insufficient":
    case "refused": {
      // THE ONE PLACE THE WIRE'S FREE STRING BECOMES OUR CLOSED WORD. Every surface downstream
      // renders a sentence per member, so a reason nobody here has a sentence for is a drift
      // between the two programs — named, then the fault path, never a payment demand invented
      // from a word we cannot read.
      if (!isAiRefusalReason(b.reason)) return { bad: "reason" };
      return { verdict: b.verdict, reason: b.reason };
    }
    case "inflight": {
      if (typeof b.source !== "string" || b.source.length === 0) return { bad: "source" };
      return { verdict: "inflight", source: b.source };
    }
    default:
      return { bad: "verdict" };
  }
}

const OUTCOMES: ReadonlySet<string> = new Set<ReleaseOutcome>(["none", "cancelled", "cancel_failed"]);

/**
 * Build the client. **Refuses to be constructed without both halves of its configuration**, and
 * that is the fail-closed direction that matters here: a client with an empty base URL would
 * dial a relative path, fault on every call, and then fail OPEN by design — an unmetered
 * deployment wearing a metered one's clothes. A host that means unmetered declares `UNMETERED`.
 */
export function makeEntitlementsClient(cfg: EntitlementsClientConfig): EntitlementsClient {
  const raw = (cfg.baseUrl ?? "").trim();
  if (raw === "") {
    throw new Error(
      "entitlements client: ENTITLEMENTS_URL is required to construct one. A host with no " +
      "entitlements program declares UNMETERED; it does not build a client that cannot dial.");
  }
  if (!/^https?:\/\//.test(raw)) {
    throw new Error("entitlements client: ENTITLEMENTS_URL must be an absolute http(s) URL");
  }
  if ((cfg.secret ?? "").trim() === "") {
    throw new Error(
      "entitlements client: BILLING_PLANE_SECRET is required — the bearer rides every request");
  }

  const base = raw.replace(/\/+$/, "");
  const budgetFor = (p: EntitlementsPath): number =>
    cfg.budgetsMs?.[p] ?? ENTITLEMENTS_CALL_BUDGET_MS;
  const ttlMs = cfg.ttlMs ?? ACCESS_TTL_MS;
  const clock = cfg.now ?? (() => Date.now());
  const fetchImpl: EntitlementsFetch =
    cfg.fetchImpl ?? (globalThis.fetch as unknown as EntitlementsFetch);
  const report = cfg.onContractFault ?? ((f: ContractFault) => {
    console.warn(
      `[entitlements] the program answered ${f.status} on ${f.path} with an unreadable `
      + `\`${f.field}\`. This is a CONTRACT DRIFT between the two sides, not a verdict: the call `
      + "took the fault path (last known verdict, else allow), so nothing is locked out and "
      + "nothing is metered on it.");
  });
  const reportCall = cfg.onCallFault ?? ((f: CallFault) => {
    console.warn(
      `[entitlements] ${f.path} `
      + (f.status === null ? "did not answer" : `answered ${String(f.status)}`)
      + ` in ${String(f.elapsedMs)} ms of a ${String(f.budgetMs)} ms budget. The call took the `
      + "fault path, so no verdict was read from it.");
  });
  /** A reporter that throws must not replace the answer with its own failure. */
  const named = (path: string, status: number, field: string): void => {
    try { report({ path, status, field }); } catch { /* observability is never load-bearing */ }
  };
  const callFault = async (
    path: EntitlementsPath, status: number | null, startedAt: number,
  ): Promise<void> => {
    try {
      await reportCall({
        path, status, elapsedMs: Date.now() - startedAt, budgetMs: budgetFor(path),
      });
    } catch { /* observability is never load-bearing */ }
  };

  /** Per-account verdicts. `freshUntil` bounds REUSE, `readAt` a read route's stale allow; the
   *  value itself is kept for the fault arm. */
  const cache = new Map<string, { verdict: AccessVerdict; readAt: number; freshUntil: number }>();
  /**
   * AT MOST ONE `/v1/access` CALL IN FLIGHT PER ACCOUNT, shared by every read that finds it —
   * a `fresh` one too. One image-heavy message sent 40-80 parallel calls for one account and
   * all of them timed out. An entry leaves as its call settles, inside the call's budget.
   */
  const inflight = new Map<string, Promise<AccessVerdict | null>>();
  /** Until when an account's last failed read answers for it ({@link ACCESS_FAULT_HOLD_MS}). */
  const faultHeldUntil = new Map<string, number>();
  /** Latched by the first 200 that carried a readable card — `/health`'s `plane` reading. */
  let pricesStated = false;

  /**
   * One bounded exchange. The clock covers the WHOLE call including the body parse, so a peer
   * that answers headers and then stalls still returns at the ceiling. Never throws: every
   * caller here has a degrade arm and a rejection would only move the mapping outwards.
   */
  const post = async (path: EntitlementsPath, payload: unknown): Promise<Exchange | null> => {
    // `Date.now()`, not the injected clock: a frozen test clock would report every call as
    // instant and switch the whole line off silently.
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`entitlements call timed out: ${path}`)), budgetFor(path));
    (timer as unknown as { unref?: () => void }).unref?.();
    const aborted = new Promise<never>((_, reject) => {
      const fire = (): void => reject(controller.signal.reason ?? new Error("aborted"));
      if (controller.signal.aborted) fire();
      else controller.signal.addEventListener("abort", fire, { once: true });
    });
    aborted.catch(() => { /* raced away */ });
    try {
      const res = await Promise.race([
        fetchImpl(`${base}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.secret}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }),
        aborted,
      ]);
      let body: unknown;
      let bodyIsJson = false;
      try {
        body = await Promise.race([res.json(), aborted]);
        bodyIsJson = true;
      } catch {
        // A non-JSON body is a fact the caller reads: `bodyIsJson` stays false, the status decides.
        body = undefined;
      }
      if (res.status !== 200) await callFault(path, res.status, startedAt);
      return { status: res.status, body, bodyIsJson };
    } catch {
      await callFault(path, null, startedAt);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /** One read of the program: the verdict it cached, or `null` for every fault (then held). */
  const ask = async (accountId: string): Promise<AccessVerdict | null> => {
    const at = clock();
    const res = await post("/v1/access", { accountId });
    // A 200 is the only answer. 400/401/503 are not verdicts about this account (the contract's
    // own status table), so they take the fault path without being reported as drift.
    if (res && res.status === 200) {
      const read = res.bodyIsJson ? verdictOf(res.body) : { bad: "body" };
      if ("bad" in read) named("/v1/access", res.status, read.bad);
      else {
        const card = pricesOf(obj(res.body)?.prices);
        if (card !== null && "bad" in card) named("/v1/access", res.status, card.bad);
        const priced = card !== null && !("bad" in card);
        if (priced) pricesStated = true;
        const verdict: AccessVerdict = read.ok && priced ? { ...read, prices: card } : read;
        cache.set(accountId, { verdict, readAt: at, freshUntil: at + ttlMs });
        faultHeldUntil.delete(accountId);
        return verdict;
      }
    }
    // Expired holds leave as a new one is written, so the map keeps one budget's faults.
    const now = clock();
    for (const [id, until] of faultHeldUntil) if (until <= now) faultHeldUntil.delete(id);
    faultHeldUntil.set(accountId, now + ACCESS_FAULT_HOLD_MS);
    return null;
  };

  /** The call in flight for this account, or a new one. Its rejection reaches every waiter. */
  const shared = (accountId: string): Promise<AccessVerdict | null> => {
    const running = inflight.get(accountId);
    if (running !== undefined) return running;
    const started: Promise<AccessVerdict | null> = ask(accountId).finally(() => {
      if (inflight.get(accountId) === started) inflight.delete(accountId);
    });
    inflight.set(accountId, started);
    return started;
  };

  const client: EntitlementsClient = {
    async access(accountId: string, opts?: AccessReadOpts): Promise<AccessVerdict> {
      const at = clock();
      const held = cache.get(accountId);
      // `fresh` SKIPS THE REUSE AND THE HOLD, NOTHING ELSE: the held verdict is still what the
      // fault arm answers with, because "we could not ask again" is not evidence that the last
      // answer is wrong. A cached refusal asked about a minute after the program recovered is
      // how a funded account gets a payment demand.
      if (!opts?.fresh) {
        if (held && held.freshUntil > at) return held.verdict;
        if ((faultHeldUntil.get(accountId) ?? 0) > at) return held?.verdict ?? UNMETERED_ACCESS;
        // A READ route answers on a held ALLOW inside the bound; the refresh runs behind it through
        // the one call in flight, and a write arriving meanwhile joins it. A held refusal waits.
        // Nobody awaits the refresh: a fault is held as ever, and a rejection has no reader.
        if (opts?.staleAllow && held?.verdict.ok && at - held.readAt < ACCESS_STALE_ALLOW_MS) {
          void shared(accountId).catch(() => undefined);
          return held.verdict;
        }
      }
      // The fault arm: the last thing we knew, however stale, and otherwise allow.
      return (await shared(accountId)) ?? held?.verdict ?? UNMETERED_ACCESS;
    },

    async accessOrFault(accountId: string): Promise<AccessVerdict | "fault"> {
      return (await shared(accountId)) ?? "fault";
    },

    async spend(
      accountId: string, action: SpendAction, attemptKey: string, meta?: SpendMeta,
    ): Promise<SpendOutcome> {
      // Refused HERE, before the dial, by the same guard the local adapter composes through: the
      // program answers 400 for a key that is already a source, and a 400 arrives at the branch
      // below as `fault` — which would degrade AI silently on a caller bug. Same input, same
      // named refusal, whichever implementation is composed.
      assertAttemptKey(action, attemptKey);
      const res = await post("/v1/spend", { accountId, action, attemptKey, ...(meta ? { meta } : {}) });
      if (!res || res.status !== 200) return { verdict: "fault" };
      const read = res.bodyIsJson ? spendOf(res.body) : { bad: "body" };
      if ("bad" in read) {
        named("/v1/spend", res.status, read.bad);
        return { verdict: "fault" };
      }
      return read;
    },

    async release(accountId: string, r: SpendRelease): Promise<ReleaseReceipt> {
      // A lost release leaves the attempt OPEN, so its retry is free — losing one costs the
      // customer nothing, which is why this swallows rather than retries. A lost REFUND is the
      // dearer half and the ledger is what makes reissuing it safe, so the caller may repeat it.
      // It is REPORTED rather than swallowed: the receipt is what lets a caller that owes money
      // back record the debt instead of dropping it.
      assertAttemptKey(r.action, r.attemptKey);
      const res = await post("/v1/spend/release", {
        accountId, action: r.action, attemptKey: r.attemptKey, refund: r.refund,
        // Named only when there is a charge to reverse. The program defaults a missing `attempt`
        // to the bare source, which is attempt 1 — so sending one on a non-refund call would put
        // a neighbour's attempt into a request that must reverse nothing.
        ...(r.refund ? { attempt: r.attempt } : {}),
        ...(r.meta ? { meta: r.meta } : {}),
      });
      // A 200 AND NOTHING ELSE. `post` already reported the outage or the refusing status through
      // `onCallFault`; a non-200 is not a release the program took, and reading one as `settled`
      // would be the swallow wearing a return type.
      return res?.status === 200 ? "settled" : "unreachable";
    },

    async manageLink(accountId: string): Promise<{ url: string } | null> {
      const res = await post("/v1/manage-link", { accountId });
      if (!res || res.status !== 200 || !res.bodyIsJson) return null;
      const b = obj(res.body);
      // `{url: null}` is an ANSWER — the program does not know this account. Only a body that
      // is neither a string nor null is drift. (It used to mean "nothing to manage"; a known
      // account now always gets a URL, because this page is the only door to a first plan.)
      if (b && b.url === null) return null;
      const url = b?.url;
      if (typeof url === "string" && url.length > 0) return { url };
      named("/v1/manage-link", res.status, "url");
      return null;
    },

    async releaseAccount(accountId: string): Promise<ReleaseOutcome> {
      const res = await post("/v1/account/release", { accountId });
      // No answer means nothing was reversed, and saying "nothing to cancel" for that is the
      // sentence that leaves a deleted customer being charged.
      if (!res || res.status !== 200 || !res.bodyIsJson) return "cancel_failed";
      const outcome = obj(res.body)?.outcome;
      if (typeof outcome === "string" && OUTCOMES.has(outcome)) return outcome as ReleaseOutcome;
      named("/v1/account/release", res.status, "outcome");
      return "cancel_failed";
    },

    async aiPricing(): Promise<"plane" | "unpriced"> {
      if (pricesStated) return "plane";
      // One bounded read through the SAME door, cached like any other, so a `/health` poller
      // dials at most once per TTL and an unanswering program costs the probe budget, not more.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PRICE_PROBE_BUDGET_MS);
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      try {
        await Promise.race([client.access(PRICE_PROBE_ACCOUNT).catch(() => undefined), budget]);
      } finally {
        clearTimeout(timer);
      }
      return pricesStated ? "plane" : "unpriced";
    },
  };
  return client;
}
