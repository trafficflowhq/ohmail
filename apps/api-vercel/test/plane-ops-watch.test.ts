import { describe, it, expect, vi, afterEach } from "vitest";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";
import { loadHostConfig, type HostConfig } from "../src/config.js";
import { buildDeps, resetServices } from "../src/deps.js";

/**
 * THE MANAGED HOST'S ALERT ROUTE READS THE BILLING PLANE'S OWN FAILURES, AND ITS CONSOLE NEVER DOES.
 * With an entitlements program the route is handed a reader over the host's one client; without one
 * it is handed `null`, the self-host truth. The console's block never carries a reader, and each
 * instance says once whether the watch is on.
 */
const cfgWith = (extra: Record<string, string>): HostConfig => loadHostConfig({
  DATABASE_URL_POOLED: "postgres://ohmail_runtime:p@localhost:5432/x",
  [KEY_RING_V1]: "ab".repeat(32),
  TF_ALERT_SECRET: "s".repeat(32),
  TF_ADMIN_SECRET: "a".repeat(32),
  DATABASE_URL_ADMIN: "postgres://ohmail_admin:p@localhost:5432/x",
  ...extra,
} as NodeJS.ProcessEnv);
const PLANE = { ENTITLEMENTS_URL: "https://plane.example", BILLING_PLANE_SECRET: "b".repeat(32) };

const watchLines = (spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> =>
  spy.mock.calls.map((c) => {
    try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return {}; }
  }).filter((l) => l.event === "plane_ops_watch");

afterEach(() => { vi.restoreAllMocks(); resetServices(); });

describe("the plane's ops reader on the managed host", () => {
  it("with an entitlements program: the route gets a reader, the console none, and the instance says on once", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const cfg = cfgWith(PLANE);
    const deps = buildDeps(new Request("https://api.ohmail.example/internal/alerts/run"), cfg);
    expect(typeof deps.alerts?.planeOps).toBe("function");
    expect(deps.admin, "the console is armed in this composition").toBeDefined();
    expect(deps.admin).not.toHaveProperty("planeOps");
    buildDeps(new Request("https://api.ohmail.example/health"), cfg);
    expect(watchLines(log)).toEqual([expect.objectContaining({ state: "on" })]);
  });

  it("without one: the route is handed null, and the instance says off once", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const cfg = cfgWith({});
    const deps = buildDeps(new Request("https://api.ohmail.example/internal/alerts/run"), cfg);
    expect(deps.alerts).toBeDefined();
    expect(deps.alerts!.planeOps).toBeNull();
    expect(deps.admin).not.toHaveProperty("planeOps");
    buildDeps(new Request("https://api.ohmail.example/health"), cfg);
    expect(watchLines(log)).toEqual([expect.objectContaining({ state: "off" })]);
  });
});
