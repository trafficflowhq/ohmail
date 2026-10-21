import { describe, it, expect, vi, afterEach } from "vitest";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";
import { loadHostConfig, type HostConfig } from "../src/config.js";
import { alertSinksFor, buildDeps, lastResortSinksFor, resetServices } from "../src/deps.js";

/**
 * The managed host's last-resort arms: the same arms as the pager's, by name and in order, the
 * webhook and Telegram objects shared, the mail arm its own (its limiter in memory). And the
 * heartbeat: read from TF_ALERT_HEARTBEAT_URL, off when unset, an unusable value named by its
 * variable and never printed.
 */
const SECRET = "s".repeat(32);
const cfgWith = (extra: Record<string, string>): HostConfig => loadHostConfig({
  DATABASE_URL_POOLED: "postgres://ohmail_runtime:p@localhost:5432/x",
  [KEY_RING_V1]: "ab".repeat(32),
  TF_ALERT_SECRET: SECRET,
  ...extra,
} as NodeJS.ProcessEnv);
const PUSH = {
  TF_ALERT_TELEGRAM_BOT_TOKEN: `${"8".repeat(10)}:${"A".repeat(35)}`,
  TF_ALERT_TELEGRAM_CHAT_ID: `-100${"7".repeat(10)}`,
};
const MAIL = {
  RESEND_API_KEY: "re_suite_fixture_key", MAIL_FROM: "ohmail <no-reply@ohmail.example>",
  TF_ALERT_EMAIL: "ops@ohmail.example",
};

afterEach(() => { vi.restoreAllMocks(); resetServices(); });

describe("the last-resort arms", () => {
  it("match the pager's arms by name and order; the webhook and Telegram objects are shared", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = cfgWith({ TF_ALERT_WEBHOOK_URL: "https://ntfy.example/ohmail", ...PUSH, ...MAIL });
    const sinks = alertSinksFor(cfg);
    const lastResort = lastResortSinksFor(cfg);
    expect(lastResort.map((s) => s.name)).toEqual(["webhook", "telegram", "mail"]);
    expect(lastResort.map((s) => s.name)).toEqual(sinks.map((s) => s.name));
    expect(lastResort[0]).toBe(sinks[0]);
    expect(lastResort[1]).toBe(sinks[1]);
    expect(buildDeps(new Request("https://api.ohmail.example/internal/alerts"), cfg).alerts?.lastResortSinks)
      .toEqual(lastResort);
  });
});

describe("the heartbeat", () => {
  it("unset is off; a URL is on; an unusable value is named, never printed", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    const req = new Request("https://api.ohmail.example/internal/alerts");
    expect(buildDeps(req, cfgWith({})).alerts?.heartbeat?.state).toBe("off");
    resetServices();
    expect(buildDeps(req, cfgWith({ TF_ALERT_HEARTBEAT_URL: "https://hc.example/ping/k1" })).alerts?.heartbeat?.state).toBe("on");
    resetServices();
    expect(buildDeps(req, cfgWith({ TF_ALERT_HEARTBEAT_URL: "'https://hc.example/ping/k2'" })).alerts?.heartbeat?.state).toBe("unusable");
    expect(logs.join("\n")).toContain("alert_heartbeat_unusable");
    expect(logs.join("\n")).toContain("TF_ALERT_HEARTBEAT_URL");
    expect(logs.join("\n")).not.toContain("hc.example");
  });
});
