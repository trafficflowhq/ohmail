import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { makeEntitlementsClient, CALL_FAULT_UNRECORDED, type CallFault } from "../src/entitlements-client.js";
import {
  entitlementsFaultRecorder, recordApiFault, ENTITLEMENTS_FAULT_GRAIN, type ApiFaultInput,
} from "../src/api-faults.js";
import { apiFaultRateText, evaluateAlerts, DEFAULT_ALERT_THRESHOLDS } from "../src/alerts.js";
import type { Tx } from "../src/change-log.js";

/**
 * A FAILED CALL TO THE ENTITLEMENTS PROGRAM IS COUNTED, FROM EITHER HOST (WORKER-ENTITLEMENTS-
 * FAULTS-ARE-NOT-COUNTED). Four of five host clients wrote no row: the hook was optional. It is
 * required now, with the opt-out spelled by name, and the one recorder writes at its arm's grain.
 */

const NOW = new Date("2026-09-29T08:00:00.000Z");
const MIN = 60_000;
const refusing = async () => ({ status: 503, json: async () => ({}) });

/** A handle whose insert records the row it was handed — the recorder's only statement. */
function capture(): { rows: ApiFaultInput[]; handle: () => Tx } {
  const rows: ApiFaultInput[] = [];
  const handle = () => ({
    insert: () => ({ values: async (v: ApiFaultInput) => { rows.push(v); } }),
  }) as unknown as Tx;
  return { rows, handle };
}

const fault = (over: Partial<CallFault> = {}): CallFault => ({
  path: "/v1/access", status: null, elapsedMs: 5_000, budgetMs: 5_000, outlivedRequest: false, attempts: 1, ...over,
});

describe("onCallFault is required, and the opt-out has a name", () => {
  it("a bag built elsewhere cannot hide the omission: the compiler and the constructor refuse it", () => {
    const bag = { baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: refusing };
    // @ts-expect-error — onCallFault is required on EntitlementsClientConfig
    expect(() => makeEntitlementsClient({ ...bag })).toThrow(/onCallFault is required/);
  });

  it("\"unrecorded\" is admitted by name, and its fault is a warn line, never a row", async () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const port = makeEntitlementsClient({
        baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: refusing,
        onCallFault: CALL_FAULT_UNRECORDED,
      });
      await port.access("acct-1");
    } finally {
      console.warn = warn;
    }
    expect(lines.some((l) => l.includes("/v1/access") && l.includes("503"))).toBe(true);
  });

  it("a client composed with the recorder writes the worker's row when the program refuses", async () => {
    const { rows, handle } = capture();
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: refusing,
      onCallFault: entitlementsFaultRecorder(handle, "worker", { now: () => NOW }),
    });
    await port.access("acct-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: "entitlements:/v1/access", status: 503, errorClass: "EntitlementsCallRefused", arm: "worker",
    });
  });
});

describe("the worker's record of an edge 429: what the caller received, and only once the retry failed too", () => {
  const open = { entitlements: {
    syncEnabled: true, canAddMailbox: true, aiEnabled: true, mailboxLimit: null, storageBytesLimit: null,
  } };
  /** The worker's composition over a program whose n-th call answers `statuses[n]`, the last repeating. */
  const worker = (statuses: number[]) => {
    let n = 0;
    const { rows, handle } = capture();
    const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24), random: () => 0,
      fetchImpl: async () => {
        const status = statuses[Math.min(n++, statuses.length - 1)]!;
        return { status, json: async () => (status === 200 ? open : { error: "rate_limited" }) };
      },
      onCallFault: entitlementsFaultRecorder(handle, "worker", {
        now: () => NOW, log: { warn: (event, fields) => { lines.push({ event, fields }); } },
      }),
    });
    return { port, rows, lines };
  };

  it("two 429s: one row at 502 under the edge class, one line with the status received and both attempts", async () => {
    const w = worker([429, 429]);
    await w.port.access("acct-1");
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]).toMatchObject({
      route: "entitlements:/v1/access", status: 502, errorClass: "EntitlementsEdgeThrottled", arm: "worker",
    });
    expect(w.lines.map((l) => l.event)).toEqual(["entitlements_call_fault"]);
    expect(w.lines[0]!.fields).toMatchObject({ status: 429, errorClass: "EntitlementsEdgeThrottled", attempts: 2 });
  });

  it("a 429 the retry recovers writes no row and no line", async () => {
    const w = worker([429, 200]);
    await expect(w.port.access("acct-1")).resolves.toMatchObject({ ok: true });
    expect([w.rows, w.lines]).toEqual([[], []]);
  });
});

describe("the recorder writes at its arm's grain, and never rejects", () => {
  it("the worker writes one row per path per minute; the API host one per call", async () => {
    let at = NOW;
    const worker = capture();
    const recordW = entitlementsFaultRecorder(worker.handle, "worker", { now: () => at });
    await recordW(fault());
    await recordW(fault());
    await recordW(fault({ path: "/v1/spend" }));
    at = new Date(NOW.getTime() + MIN);
    await recordW(fault());
    expect(worker.rows.map((r) => r.route)).toEqual([
      "entitlements:/v1/access", "entitlements:/v1/spend", "entitlements:/v1/access",
    ]);

    const api = capture();
    const recordA = entitlementsFaultRecorder(api.handle, "api", { now: () => NOW });
    await recordA(fault());
    await recordA(fault());
    expect(api.rows).toHaveLength(2);
    expect(ENTITLEMENTS_FAULT_GRAIN).toEqual({ api: "call", worker: "minute" });
  });

  it("a row that cannot be written is a warn line, not the caller's error", async () => {
    const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const record = entitlementsFaultRecorder(() => { throw new Error("pool closed"); }, "worker", {
      now: () => NOW, log: { warn: (event, fields) => { lines.push({ event, fields }); } },
    });
    await expect(record(fault())).resolves.toBeUndefined();
    expect(lines.map((l) => l.event)).toEqual(["entitlements_call_fault", "entitlements_fault_unrecorded"]);
  });
});

describe("api_fault_rate words a call OUT as a failed call to the program (row 48 by ruling)", () => {
  const t = DEFAULT_ALERT_THRESHOLDS;
  it("per arm: calls from the API host, minutes from the worker; a served route is unchanged", () => {
    expect(apiFaultRateText({ route: "entitlements:/v1/access", arm: "api", faults: 12, minutes: 2, newest: NOW }, t, NOW).title)
      .toBe("calls from the API host to the entitlements program failed 12 times");
    const w = apiFaultRateText({ route: "entitlements:/v1/access", arm: "worker", faults: 14, minutes: 10, newest: NOW }, t, NOW);
    expect(w.title).toBe("calls from the worker to the entitlements program failed in 10 separate minute(s)");
    expect(w.detail).toContain("counts minutes, not calls");
    expect(w.detail).toContain("failed in 10 of the 11 clock minutes the last 10m touches, past the floor of 3 minutes");
    expect(w.detail).not.toContain("answered");
    expect(apiFaultRateText({ route: "/messages/:id", arm: "api", faults: 11, minutes: 3, newest: NOW }, t, NOW).title)
      .toBe("/messages/:id answered 11 5xx");
  });

  it("the worker's ten minutes of failed calls fire under the worker's key with that title", async () => {
    const db = await makeTestDb();
    for (let k = 0; k < 10; k++) {
      await recordApiFault(db, {
        route: "entitlements:/v1/access", method: "POST", status: 504,
        errorClass: "EntitlementsCallTimeout", requestId: null, arm: "worker",
        at: new Date(NOW.getTime() - k * MIN),
      });
    }
    const alerts = await evaluateAlerts(db, { now: NOW });
    const hit = alerts.find((a) => a.key === "api_fault_rate:worker:entitlements:/v1/access");
    expect(hit?.title).toBe("calls from the worker to the entitlements program failed in 10 separate minute(s)");
  });
});
