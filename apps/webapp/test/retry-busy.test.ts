import { describe, expect, it } from "vitest";
import { ApiError } from "../app/api-client";
import { isBusy, retryBusy } from "../app/retry-busy";
import { CONFIRM_ATTEMPTS, CONFIRM_CAP_MS } from "@ohmail/app-logic/session/confirm-schedule";

/**
 * `retryBusy` — the one rule for a press that meets the API's busy answer. It retries ONLY our
 * coded `db_busy`, on the shell's confirm ladder (its attempts, its cap, the server's
 * `Retry-After` as the seed), and rethrows everything else at once so a refusal keeps its speed.
 * The waits are recorded rather than slept: `sleep` is the seam, and the numbers are the module's.
 */

const busy = (over: { retryable?: boolean; retryAfterMs?: number; coded?: boolean } = {}): ApiError =>
  new ApiError(503, "db_busy", "busy", undefined, {
    coded: over.coded ?? true,
    ...(over.retryable !== undefined ? { retryable: over.retryable } : { retryable: true }),
    ...(over.retryAfterMs !== undefined ? { retryAfterMs: over.retryAfterMs } : {}),
  });

function recorder(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

describe("retryBusy", () => {
  it("retries a coded db_busy and returns the answer that follows it", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const out = await retryBusy(async () => {
      calls += 1;
      if (calls < 3) throw busy({ retryAfterMs: 5_000 });
      return "minted";
    }, { sleep });
    expect(out).toBe("minted");
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it("asks at most CONFIRM_ATTEMPTS times, then rethrows the busy answer for the page to word", async () => {
    const { waits, sleep } = recorder();
    let calls = 0;
    const err = await retryBusy(async () => { calls += 1; throw busy(); }, { sleep })
      .catch((e: unknown) => e);
    expect(calls).toBe(CONFIRM_ATTEMPTS);
    expect(waits).toHaveLength(CONFIRM_ATTEMPTS - 1);
    expect(isBusy(err)).toBe(true);
  });

  it("seeds each wait with Retry-After, jittered below it, and never past the cap", async () => {
    const { waits, sleep } = recorder();
    await retryBusy(async () => { throw busy({ retryAfterMs: 5_000 }); }, { sleep }).catch(() => {});
    expect(waits[0]).toBeGreaterThanOrEqual(2_500);
    expect(waits[0]).toBeLessThanOrEqual(5_000);
    for (const w of waits) expect(w).toBeLessThanOrEqual(CONFIRM_CAP_MS);
  });

  it("rethrows anything that is not our busy answer at once — no wait, one ask", async () => {
    for (const err of [
      new ApiError(401, "unauthorized", "no"),
      new ApiError(403, "step_up_required", "again", undefined, { coded: true }),
      new ApiError(503, "unavailable", "down", undefined, { coded: true, retryable: true }),
      busy({ coded: false }),
      new Error("not an ApiError"),
    ]) {
      const { waits, sleep } = recorder();
      let calls = 0;
      const got = await retryBusy(async () => { calls += 1; throw err; }, { sleep }).catch((e: unknown) => e);
      expect(got).toBe(err);
      expect(calls).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  it("a write the server marks not-retryable is retried only when the caller says a replay is harmless", async () => {
    const plain = recorder();
    let calls = 0;
    await retryBusy(async () => { calls += 1; throw busy({ retryable: false }); }, { sleep: plain.sleep })
      .catch(() => {});
    expect(calls).toBe(1);

    const safe = recorder();
    calls = 0;
    await retryBusy(async () => { calls += 1; throw busy({ retryable: false }); },
      { sleep: safe.sleep, replaySafe: true }).catch(() => {});
    expect(calls).toBe(CONFIRM_ATTEMPTS);
  });

  it("tells the page each wait before it starts", async () => {
    const seen: Array<[number, number]> = [];
    let calls = 0;
    await retryBusy(async () => { calls += 1; if (calls < 2) throw busy(); return "ok"; }, {
      sleep: async () => {},
      onWait: (ms, retry) => { seen.push([ms, retry]); },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toBe(1);
    expect(seen[0]![0]).toBeGreaterThan(0);
  });

  it("stops when the page is gone: no ask after an abort", async () => {
    const controller = new AbortController();
    let calls = 0;
    const got = await retryBusy(async () => { calls += 1; throw busy(); }, {
      signal: controller.signal,
      sleep: async () => { controller.abort(); },
    }).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(isBusy(got)).toBe(true);
  });
});
