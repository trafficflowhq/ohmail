import { describe, it, expect, afterEach, vi } from "vitest";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";
import { loadHostConfig, type HostConfig } from "../src/config.js";
import { buildDeps, resetServices } from "../src/deps.js";

/**
 * A DRILL'S ACK LINK ON THE MANAGED HOST is `TF_APP_URL` (through `assertAppUrl`) and the web app's
 * `/api` rewrite, never the request's own Host. A `TF_APP_URL` the host refused arms no drill.
 */
const cfgWith = (extra: Record<string, string>): HostConfig => loadHostConfig({
  // Never dialed.
  DATABASE_URL_POOLED: "postgres://ohmail_runtime@localhost:5432/x",
  [KEY_RING_V1]: "ab".repeat(32),
  TF_ALERT_SECRET: "s".repeat(32),
  ...extra,
} as NodeJS.ProcessEnv);

afterEach(() => { vi.restoreAllMocks(); resetServices(); });

describe("the drill's ack base on the managed host", () => {
  it("is TF_APP_URL's origin under /api, whatever Host the request named", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = buildDeps(new Request("https://elsewhere.example/internal/alerts/drill"), cfgWith({ TF_APP_URL: "https://ohmail.app/" }));
    expect(deps.alerts?.drillAckBase).toBe("https://ohmail.app/api");
  });

  it("is absent when TF_APP_URL was refused, so no drill starts", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = buildDeps(new Request("https://ohmail.app/internal/alerts/drill"), cfgWith({ TF_APP_URL: "https://ohmail.example" }));
    expect(deps.alerts).toBeDefined();
    expect(deps.alerts!.drillAckBase).toBeUndefined();
  });
});
