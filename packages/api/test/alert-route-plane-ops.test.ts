/* THE API DRIVER READS THE BILLING PLANE'S OWN FAILURES (/v1/ops) ON ITS PASS. The route forwards
   the host's reader, answers what the reading came to as `planeOps`, and logs `plane_ops_state`
   only when that changes: info for a read, warn for anything else, never a value. */
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { createLogger } from "@trafficflow/core";
import type { PlaneOpsReading } from "@trafficflow/db/cloud";
import { makeDeps } from "./helpers.js";

const app = createApp(apiRoutes);
const SECRET = "s".repeat(32);

function captured(): { lines: Array<Record<string, unknown>>; logger: ApiDeps["logger"] } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    service: "api", level: "debug", sink: (l: string) => { lines.push(JSON.parse(l) as Record<string, unknown>); },
  });
  return { lines, logger };
}

async function pass(deps: ApiDeps, planeOps: (() => Promise<PlaneOpsReading>) | null | undefined) {
  const res = await app.handle(
    new Request("http://api.test/internal/alerts/run", { headers: { authorization: `Bearer ${SECRET}` } }),
    { ...deps, session: null, alerts: { secret: SECRET, sinks: [], parkedAccounts: null, accountsAtCap: null, planeOps } },
  );
  expect(res.status).toBe(200);
  return await res.json() as { planeOps: string; unread: Array<{ kind: string; reason: string }> };
}

const ok = (): PlaneOpsReading => ({
  state: "read",
  answer: { v: 1, observedAt: new Date().toISOString(), passes: [], alerts: [], alertsTruncated: false },
});

describe("the route forwards the plane's ops reader and says what it read", () => {
  it("no reader stated: planeOps is off and the three plane rules are unread, never clear", async () => {
    const { deps } = await makeDeps();
    for (const planeOps of [undefined, null]) {
      const body = await pass(deps, planeOps);
      expect(body.planeOps).toBe("off");
      for (const kind of ["plane_pass_stale", "billing_alert", "plane_ops_unreadable"]) {
        expect(body.unread).toContainEqual({ kind, reason: "no_reader" });
      }
    }
  });

  it("each pass asks once and answers the reading's state; the state line is written on change only", async () => {
    const { deps } = await makeDeps();
    const { lines, logger } = captured();
    const d = { ...deps, logger };
    const readings: PlaneOpsReading[] = [
      ok(), ok(),
      { state: "refused", status: 401 }, { state: "refused", status: 401 }, { state: "refused", status: 503 },
      { state: "unreadable", field: "alerts[3].key" }, { state: "unsupported" }, ok(),
    ];
    let asked = 0;
    for (const reading of readings) {
      const before = asked;
      const body = await pass(d, async () => { asked += 1; return reading; });
      expect(asked - before, "one read per pass").toBe(1);
      expect(body.planeOps).toBe(reading.state);
    }
    const said = lines.filter((l) => l.event === "plane_ops_state")
      .map((l) => [l.level, l.state, l.status ?? null, l.reason ?? null]);
    expect(said).toEqual([
      ["info", "read", null, null],
      ["warn", "refused", 401, null],
      ["warn", "refused", 503, null],
      ["warn", "unreadable", null, "alerts[3].key"],
      ["warn", "unsupported", null, null],
      ["info", "read", null, null],
    ]);
    expect(lines.filter((l) => "droppedFields" in l), "the logger census refused a field").toEqual([]);
  });
});
