/* THE CONSOLE'S OVERVIEW UNDER A PLANE THAT HANGS (a low review finding, an architecture acceptance
   item). The host's parked reader is bounded, so the Reliability page answers inside its own
   bound, names the rule it read in part, and still names the last pass time; the calls it left
   hanging hold no later read. And no staff read closes over `deps`. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { accounts, mailboxes, parkedAccountsOf } from "@trafficflow/db";
import {
  alertPassRuns, makeEntitlementsClient, ALERT_PARKED_READ_BOUND, CALL_FAULT_UNRECORDED,
} from "@trafficflow/db/cloud";
import { withoutCommentsAndLiterals, bracketSpan } from "../../../scripts/lib/source-scan.mjs";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import { makeDeps, seedStaffSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const SECRET = "admin-console-internal-secret-fixture-token";
const HOUR = 3_600_000;
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function world(lagging: number) {
  const { db, deps } = await makeDeps();
  const owner = await seedStaffSession(db, { now: FIXED_NOW, roles: ["owner"] });
  for (let i = 0; i < lagging; i++) {
    const [acct] = await db.insert(accounts).values({ name: `lag${i}` }).returning();
    await db.insert(mailboxes).values({
      accountId: acct!.id, provider: "imap", status: "connected", address: `lag${i}@example.test`,
      lastSyncAt: new Date(FIXED_NOW.getTime() - 3 * HOUR), createdAt: new Date(FIXED_NOW.getTime() - 240 * HOUR),
    });
  }
  const workerRanAt = new Date(FIXED_NOW.getTime() - 4 * 60_000);
  await db.insert(alertPassRuns).values({ driver: "worker", ranAt: workerRanAt });
  const client = makeEntitlementsClient({
    baseUrl: "http://plane.invalid", secret: "s".repeat(32),
    fetchImpl: (() => new Promise(() => {})) as never,
    budgetsMs: { "/v1/access": ALERT_PARKED_READ_BOUND.boundMs * 4 },
    onCallFault: CALL_FAULT_UNRECORDED,
  });
  const read = () => H(req("GET", "/admin/overview", { bearer: SECRET, headers: { [STAFF_SESSION_HEADER]: owner.token } }), {
    ...deps, admin: { secret: SECRET, environment: "test", parkedAccounts: parkedAccountsOf(client, ALERT_PARKED_READ_BOUND) } as AdminConfig,
  });
  return { read, workerRanAt };
}

describe("the Reliability page under a hanging entitlements program", () => {
  it("answers inside its own bound, lists sync_lag as partial, and names the last pass time", async () => {
    const w = await world(24);
    const t0 = Date.now();
    const res = await w.read();
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(ms, "inside the parked read's bound").toBeLessThan(ALERT_PARKED_READ_BOUND.boundMs + 1_500);
    const body = await res.json() as {
      alertsUnread: Array<{ kind: string; reason: string }>;
      alertDrivers: Array<{ driver: string; ranAt: string | null }>;
    };
    expect(body.alertsUnread).toContainEqual({ kind: "sync_lag", reason: "partial" });
    expect(body.alertDrivers.find((d) => d.driver === "worker")?.ranAt).toBe(w.workerRanAt.toISOString());
  }, 20_000);

  it("concurrent reads each answer, and the next read is not held by the calls left hanging", async () => {
    const w = await world(24);
    const [a, b] = await Promise.all([w.read(), w.read()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const t0 = Date.now();
    const c = await w.read();
    expect(c.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(ALERT_PARKED_READ_BOUND.boundMs + 1_500);
  }, 30_000);
});

describe("no staff read closes over deps", () => {
  it("every adminRoute(...) call's arguments name no `deps` (control: the handler around it does)", () => {
    const src = withoutCommentsAndLiterals(readFileSync(fileURLToPath(new URL("../src/routes/admin.ts", import.meta.url)), "utf8"));
    const calls = [...src.matchAll(/\badminRoute\(/g)].map((m) => {
      const open = m.index! + m[0].length - 1;
      const { start, end, closed } = bracketSpan(src, open);
      expect(closed).toBe(true);
      return src.slice(start, end);
    });
    expect(calls.length, "the routes were read").toBeGreaterThanOrEqual(8);
    expect(calls.filter((c) => /\bdeps\b/.test(c))).toEqual([]);
    expect(/\bdeps\.admin\?\.parkedAccounts\b/.test(src), "control: the handler reads the reader from deps").toBe(true);
  });
});
