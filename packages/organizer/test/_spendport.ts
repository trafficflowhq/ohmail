import {
  sourceFor,
  type ReleaseReceipt, type SpendMeta, type SpendOutcome, type SpendPort, type SpendRelease,
} from "@trafficflow/db";

/**
 * A RECORDING SPEND PORT for the worker's own suites — the twin of
 * `packages/services/test/helpers/spend-port-fake.ts`, and there are two on purpose.
 *
 * The import boundary is why: a worker test may import `@trafficflow/core` and `@trafficflow/db` and nothing
 * else from the workspace (`deps.test.ts` is the guard), so reaching into the services test
 * helpers from here would dissolve the boundary that keeps the services barrel out of the
 * worker's boot graph. Both doubles implement {@link SpendPort}, so a divergence from the
 * contract is a compile error in each rather than a difference nobody notices.
 *
 * FAILS THE WAY THE SERVER FAILS: `spend` and `release` never throw — a fault is the `fault`
 * verdict, exactly as the port states. `sourceFor` is called for real, so a caller that passes
 * an already-composed source instead of a bare attempt key is refused here as it is in
 * production.
 */
export interface SpendCall {
  accountId: string;
  action: Parameters<SpendPort["spend"]>[1];
  /** The BARE key the call site passed. */
  attemptKey: string;
  /** What `sourceFor` composes from the pair. */
  source: string;
  meta?: SpendMeta;
  /**
   * WHAT THE PORT ANSWERED. Recorded beside the ask because a caller's behaviour is only
   * readable against the verdict it was given — and because "how many were CHARGED" is
   * otherwise indistinguishable from "how many asked", which is the count a ledger used to
   * answer.
   */
  outcome: SpendOutcome;
}

export interface FakeSpendPort extends SpendPort {
  readonly spends: SpendCall[];
  readonly releases: Array<SpendRelease & { accountId: string }>;
  /**
   * Answer this verdict to every later `spend`, OVERRIDING {@link FakeSpendPort.exclusive} and
   * {@link FakeSpendPort.budget}. An override, because that is what a case that calls it means:
   * before this, a standing `inflight` was silently ignored while exclusivity was on — the
   * source was unheld, so the double answered `ok` and the case under it passed for the wrong
   * reason.
   */
  answer(v: SpendOutcome): void;
  /** Answer once, then fall back to the standing verdict. */
  answerOnce(v: SpendOutcome): void;
  /** A balance as a counter: admit `n` more spends, then answer `insufficient`. */
  budget(n: number): void;
  /**
   * The port's own per-source exclusivity: the first spend for a source is `ok`, another for the
   * SAME source while it is unreleased is `inflight`, and a released source answers `duplicate`.
   */
  exclusive(): void;
  /**
   * ANSWER `unreachable` TO EVERY LATER RELEASE — the entitlements outage, in the shape production
   * has it: the call resolves, nothing was taken, and the receipt says so. A double that kept
   * answering `settled` here would measure the obligation's settle path against a state the
   * program never reaches, which is the class of defect this double exists to make impossible.
   */
  releasesAreLost(): void;
}

export function fakeSpendPort(
  initial: SpendOutcome = { verdict: "ok", charged: true, attempt: "1" },
): FakeSpendPort {
  const spends: SpendCall[] = [];
  const releases: Array<SpendRelease & { accountId: string }> = [];
  const queued: SpendOutcome[] = [];
  const held = new Map<string, string | null>();
  let standing = initial;
  let remaining: number | null = null;
  let issued = 0;
  let exclusiveMode = false;
  /** Whether every later release is lost — see {@link FakeSpendPort.releasesAreLost}. */
  let lost = false;
  /** Whether a case has SET a standing verdict — see {@link FakeSpendPort.answer}. */
  let standingSet = false;
  return {
    spends, releases,
    answer(v) { standing = v; remaining = null; standingSet = true; },
    answerOnce(v) { queued.push(v); },
    budget(n) { remaining = n; },
    exclusive() { exclusiveMode = true; },
    async spend(accountId, action, attemptKey, meta) {
      const source = sourceFor(action, attemptKey);
      const record = (outcome: SpendOutcome): SpendOutcome => {
        spends.push({ accountId, action, attemptKey, source, ...(meta ? { meta } : {}), outcome });
        return outcome;
      };
      const queuedVerdict = queued.shift();
      if (queuedVerdict) return record(queuedVerdict);
      // An explicit standing verdict outranks both the claim book and the budget.
      if (standingSet) return record(standing);
      if (exclusiveMode && held.has(source)) {
        return record(held.get(source) === null
          ? { verdict: "duplicate", charged: false, attempt: `attempt-${source}` }
          : { verdict: "inflight", source });
      }
      if (remaining !== null) {
        if (remaining <= 0) return record({ verdict: "insufficient", reason: "out_of_credits" });
        remaining -= 1;
      } else if (!exclusiveMode) {
        return record(standing);
      }
      const attempt = `attempt-${++issued}`;
      if (exclusiveMode) held.set(source, attempt);
      return record({ verdict: "ok", charged: true, attempt });
    },
    releasesAreLost() { lost = true; },
    async release(accountId, r): Promise<ReleaseReceipt> {
      releases.push({ accountId, ...r });
      // A LOST RELEASE MOVES NOTHING, including the claim book: that is what makes it lost. The
      // first cut recorded the release and then reported `unreachable`, so a case could assert a
      // refund was owed while this double had already given the claim back.
      if (lost) return "unreachable";
      const source = sourceFor(r.action, r.attemptKey);
      if (r.refund) held.delete(source);
      else if (held.has(source)) held.set(source, null);
      return "settled";
    },
  };
}
