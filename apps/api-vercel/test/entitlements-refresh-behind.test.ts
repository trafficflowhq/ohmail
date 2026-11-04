import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiDeps } from "@trafficflow/api";
import { accessOf } from "@trafficflow/db";
import type { ApiFaultInput } from "@trafficflow/db/cloud";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/* Every row the host's fault recorder wrote. The DATABASE is the one seam replaced: the host's
   shared recorder runs for real (its grain, its row, its log line) over a handle that keeps what it
   inserts, and the rest of the composition is `buildDeps` as production builds it. */
const rows: ApiFaultInput[] = [];
vi.mock("@trafficflow/db/cloud", async (importOriginal) => {
  const real = await importOriginal<typeof import("@trafficflow/db/cloud")>();
  const keeping = { insert: () => ({ values: async (v: ApiFaultInput) => { rows.push(v); } }) };
  return {
    ...real,
    recordApiFault: async (_db: unknown, row: ApiFaultInput) => { rows.push(row); },
    entitlementsFaultRecorder: (_handle: unknown, ...rest: Parameters<typeof real.entitlementsFaultRecorder> extends [unknown, ...infer R] ? R : never) =>
      real.entitlementsFaultRecorder(() => keeping as never, ...rest),
  };
});

const { loadHostConfig } = await import("../src/config.js");
const { buildDeps } = await import("../src/deps.js");
const { QUIET_HOLD_MS } = await import("../src/handler.js");
const { POOLED_IDLE_TIMEOUT_S } = await import("@trafficflow/db/cloud");

/**
 * THE REFRESH BEHIND A READ ROUTE, ON THIS HOST (2026-09-28). A read route answers on a held allow
 * and the `/v1/access` refresh runs after the response. This platform keeps an instance running
 * only for work handed to its `waitUntil`; everything else is frozen with the instance, and on
 * thaw the 5 s abort fires before the plane's answer is read. Those rows paged the operator ~90
 * times a day while the plane answered 200 to every call.
 *
 * The platform is modelled at its two facts: the request context the runtime installs, and the
 * freeze after the response. The plane answers only while the instance is running.
 */
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");
const ACC = "acc-refresh-behind";
const PLANE_MS = 300;
const handed: Array<Promise<unknown>> = [];

function plane(): { deliverAfter(ms: number): void; pending: number } {
  let waiting: Array<() => void> = [];
  const state = {
    get pending() { return waiting.length; },
    deliverAfter(ms: number) {
      const run = waiting;
      waiting = [];
      setTimeout(() => { for (const go of run) go(); }, ms);
    },
  };
  (globalThis as { fetch: unknown }).fetch = (_url: string, init: { signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      waiting.push(() => resolve({
        status: 200,
        json: async () => ({
          entitlements: { syncEnabled: true, canAddMailbox: true, aiEnabled: true, mailboxLimit: 5, storageBytesLimit: null },
        }),
      }));
    });
  return state;
}

const realFetch = globalThis.fetch;
/** The host's `entitlements_call_fault` lines, parsed off the logger's console sink. */
let lines: Array<Record<string, unknown>> = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    try {
      const parsed = JSON.parse(String(line)) as Record<string, unknown>;
      if (parsed.event === "entitlements_call_fault") lines.push(parsed);
    } catch { /* not a structured line */ }
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  rows.length = 0;
  handed.length = 0;
  (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = {
    get: () => ({ waitUntil: (p: Promise<unknown>) => { handed.push(p); } }),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  (globalThis as { fetch: unknown }).fetch = realFetch;
  delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
});

const depsFor = (): ApiDeps => buildDeps(
  new Request("https://api.ohmail.app/mailboxes"),
  loadHostConfig({
    DATABASE_URL_POOLED: "postgres://ohmail_runtime:p@localhost:5432/x",
    [KEY_RING_V1]: "ab".repeat(32),
    ENTITLEMENTS_URL: "https://entitlements.example",
    BILLING_PLANE_SECRET: "entitlements-billing-plane-fixture-token",
  } as NodeJS.ProcessEnv),
);

/**
 * One read route on one instance: the gate's ask answers, the platform keeps the instance up for
 * what was handed to it (the plane answering after `planeMs`), then freezes it for a minute.
 */
async function serveRead(deps: ApiDeps, p: ReturnType<typeof plane>, planeMs: number): Promise<void> {
  const answered = await accessOf(deps.services!.entitlementsPort!, ACC, { staleAllow: true });
  expect(answered, "the read route answered on the held allow").toMatchObject({ ok: true });
  if (handed.length > 0) {
    p.deliverAfter(planeMs);
    await vi.advanceTimersByTimeAsync(planeMs + 1 + QUIET_HOLD_MS);
    await Promise.all(handed.splice(0));
  }
  await vi.advanceTimersByTimeAsync(60_000);
  p.deliverAfter(0);
  await vi.advanceTimersByTimeAsync(1);
}

/** A warm instance holding an allow read 61 s ago: the next read route refreshes it behind. */
async function heldAllow(deps: ApiDeps, p: ReturnType<typeof plane>): Promise<void> {
  const first = accessOf(deps.services!.entitlementsPort!, ACC);
  p.deliverAfter(PLANE_MS);
  await vi.advanceTimersByTimeAsync(PLANE_MS + 1);
  await expect(first).resolves.toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(61_000);
}

describe("the refresh behind a read route is kept alive by the host", () => {
  it("the refresh is handed to the platform, completes, and writes no fault row", async () => {
    const p = plane();
    const deps = depsFor();
    await heldAllow(deps, p);
    await serveRead(deps, p, PLANE_MS);
    expect(rows, "the plane answered 200; nothing may be recorded as its fault").toEqual([]);
    expect(lines, "and nothing is logged as one").toEqual([]);
    expect(p.pending, "the refresh was answered").toBe(0);
  });

  it("a slow plane behind the response still writes its row, of the class that outlived its request", async () => {
    const p = plane();
    const deps = depsFor();
    await heldAllow(deps, p);
    await serveRead(deps, p, 6_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: "entitlements:/v1/access", status: 504, errorClass: "EntitlementsCallOutlivedRequest",
    });
    expect(lines, "the warn line the same call writes").toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "warn", route: "entitlements:/v1/access", status: null,
      errorClass: "EntitlementsCallOutlivedRequest", budgetMs: 5_000,
    });
    expect(lines[0]!.elapsedMs, "how long the call ran is on the line").toBeGreaterThanOrEqual(5_000);
  });

  it("the instance stays awake a quiet hold past the refresh's end, so a connection it opened closes first", async () => {
    const p = plane();
    const deps = depsFor();
    await heldAllow(deps, p);
    await accessOf(deps.services!.entitlementsPort!, ACC, { staleAllow: true });
    expect(handed).toHaveLength(1);
    let settled = false;
    void handed[0]!.then(() => { settled = true; });
    p.deliverAfter(PLANE_MS);
    await vi.advanceTimersByTimeAsync(PLANE_MS + 1);
    expect(p.pending, "the refresh was answered").toBe(0);
    await vi.advanceTimersByTimeAsync(POOLED_IDLE_TIMEOUT_S * 1000);
    expect(settled, "released before the pool's idle close").toBe(false);
    await vi.advanceTimersByTimeAsync(QUIET_HOLD_MS);
    expect(settled).toBe(true);
    handed.length = 0;
  });

  it("control: a slow plane inside a live request stays a timeout the alert counts", async () => {
    plane();
    const deps = depsFor();
    const read = accessOf(deps.services!.entitlementsPort!, ACC);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(read, "the fault arm answers allow").resolves.toMatchObject({ ok: true });
    expect(rows.map((r) => r.errorClass)).toEqual(["EntitlementsCallTimeout"]);
    expect(lines[0]).toMatchObject({ errorClass: "EntitlementsCallTimeout", status: null });
  });
});
