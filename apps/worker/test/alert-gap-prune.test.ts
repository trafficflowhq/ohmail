import { describe, it, expect, vi } from "vitest";
import { alertGapPrunePass } from "../src/alert-gap-prune.js";
import type { Tx } from "@trafficflow/db";

/** The retention pass rides the alert pass inside the worker: it never throws. */
function logger(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn() };
}

describe("alert_driver_gaps retention pass", () => {
  it("swallows a missing table (a host ahead of cloud 0048) and reports zero", async () => {
    const log = logger();
    const err = Object.assign(new Error('relation "alert_driver_gaps" does not exist'), { code: "42P01" });
    const db = { delete: () => ({ where: () => Promise.reject(err) }) } as unknown as Tx;
    await expect(alertGapPrunePass(db, new Date(), log as never)).resolves.toBe(0);
    expect(log.warn).toHaveBeenCalledWith("alert_gap_prune_failed", expect.objectContaining({ err }));
  });

  it("logs the drain only when something was removed", async () => {
    const counting = (count: number) =>
      ({ delete: () => ({ where: () => Promise.resolve({ count }) }) }) as unknown as Tx;
    const quiet = logger();
    await expect(alertGapPrunePass(counting(0), new Date(), quiet as never)).resolves.toBe(0);
    expect(quiet.info).not.toHaveBeenCalled();
    const loud = logger();
    await expect(alertGapPrunePass(counting(2), new Date(), loud as never)).resolves.toBe(2);
    expect(loud.info).toHaveBeenCalledWith("alert_gap_prune", { removed: 2 });
  });
});
