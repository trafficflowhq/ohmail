/* OWED REVERSALS FOLLOW THE ENTITLEMENTS PROGRAM'S CREDITS RULE (LOW-8).
   A reader holding only `ops` is told they are withheld, never shown the count or "none owed";
   support, billing and owner read them, and a mixed role reads them through its other role. */
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import { creditRefundObligations } from "@trafficflow/db/cloud";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import { makeDeps, seedSession, seedStaffSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const SECRET = "admin-console-internal-secret-fixture-token";
const HOUR = 3_600_000;
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

async function world() {
  const { db, deps } = await makeDeps();
  const customer = await seedSession(db, { now: FIXED_NOW });
  await db.insert(creditRefundObligations).values({
    accountId: customer.accountId, action: "screener_advice", attemptKey: "k1", attempt: "a1",
    reason: "drafter_failed", owedAt: new Date(FIXED_NOW.getTime() - 30 * HOUR), settledAt: null,
    tries: 3, lastFault: "release_unreachable",
  });
  const d = { ...deps, admin: { secret: SECRET, environment: "test" } as AdminConfig } as ApiDeps;
  const pageAs = async (roles: Array<"support" | "billing" | "ops" | "owner">) => {
    const staff = await seedStaffSession(db, { now: FIXED_NOW, roles });
    const res = await H(req("GET", `/admin/accounts/${customer.accountId}`, {
      bearer: SECRET, headers: { [STAFF_SESSION_HEADER]: staff.token },
    }), d);
    expect(res.status, roles.join("+")).toBe(200);
    return JSON.parse(await res.text()) as { owedReversals: unknown };
  };
  return { pageAs };
}

describe("owed reversals on the account page, by role", () => {
  it("ops alone is refused them by name: withheld, with no count and no fault word", async () => {
    const w = await world();
    const page = await w.pageAs(["ops"]);
    expect(page.owedReversals).toBe("withheld");
    expect(JSON.stringify(page)).not.toContain("release_unreachable");
  });

  it("control: support, billing and owner read them, and ops with another role reads them", async () => {
    const w = await world();
    const expected = { count: 1, oldestOwedAt: new Date(FIXED_NOW.getTime() - 30 * HOUR).toISOString(), tries: 3, lastFault: "release_unreachable" };
    for (const roles of [["support"], ["billing"], ["owner"], ["ops", "support"]] as const) {
      expect((await w.pageAs([...roles])).owedReversals, roles.join("+")).toEqual(expected);
    }
  });
});
