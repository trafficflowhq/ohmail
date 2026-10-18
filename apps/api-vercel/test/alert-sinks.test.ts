import { describe, it, expect, vi, afterEach } from "vitest";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";
import { loadHostConfig, type HostConfig } from "../src/config.js";
import { alertSinksFor, buildDeps } from "../src/deps.js";

/**
 * THE MANAGED HOST'S PAGER ARMS WHEN ONE CANNOT BE BUILT. `alert_sink_unavailable` used to drop
 * the arm: `/health` listed the survivors as the whole pager, the pager verdict read `ok` and no
 * other driver could tell an arm was gone. A throw now leaves the arm in place, refusing every
 * page as `misconfigured`, and the arms composed after it are still composed.
 *
 * Under a test runner `ResendMailer` refuses to construct over the real network transport, so
 * the mail arm's build throws here exactly as a broken one does in production.
 */
const SECRET = "s".repeat(32);
const cfgWith = (extra: Record<string, string>): HostConfig => loadHostConfig({
  DATABASE_URL_POOLED: "postgres://ohmail_runtime:p@localhost:5432/x",
  [KEY_RING_V1]: "ab".repeat(32),
  TF_ALERT_SECRET: SECRET,
  ...extra,
} as NodeJS.ProcessEnv);

const MAIL = {
  RESEND_API_KEY: "re_suite_fixture_key", MAIL_FROM: "ohmail <no-reply@ohmail.example>",
  TF_ALERT_EMAIL: "ops@ohmail.example",
};
const PUSH = {
  // Shaped like a BotFather token and a chat id, and neither is one.
  TF_ALERT_TELEGRAM_BOT_TOKEN: `${"8".repeat(10)}:${"A".repeat(35)}`,
  TF_ALERT_TELEGRAM_CHAT_ID: `-100${"7".repeat(10)}`,
};

afterEach(() => { vi.restoreAllMocks(); });

describe("a pager arm that cannot be built is published as refusing, never dropped", () => {
  it("the mail arm's build throws: it is present and refuses as misconfigured, naming no value", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sinks = alertSinksFor(cfgWith({ TF_ALERT_WEBHOOK_URL: "https://ntfy.example/ohmail", ...PUSH, ...MAIL }));
    expect(sinks.map((s) => s.name)).toEqual(["webhook", "telegram", "mail"]);
    const out = await sinks.find((s) => s.name === "mail")!.notify([], {
      source: "api", environment: "production", now: new Date(),
    });
    expect(out).toMatchObject({ ok: false, outcome: "misconfigured" });
    expect(JSON.stringify(out)).not.toContain("re_suite_fixture_key");
    expect(JSON.stringify(out)).not.toContain("ops@ohmail.example");
  });

  it("/health lists the broken arm beside the others and states the pager verdict", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = cfgWith({ ...PUSH, ...MAIL });
    const summary = buildDeps(new Request("https://api.ohmail.example/health"), cfg).health?.alertSinks?.();
    expect(summary?.arms.map((a) => a.name)).toEqual(["telegram", "mail"]);
    expect(summary?.arms[1]?.outcome, "known dead from boot, not unexercised").toBe("misconfigured");
    expect(summary?.pager, "a telegram arm never attempted is not dead").toBe("ok");
  });

  it("a host whose only arm could not be built reads dead on /health before any page", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const summary = buildDeps(new Request("https://api.ohmail.example/health"), cfgWith({ ...MAIL })).health?.alertSinks?.();
    expect(summary?.arms).toEqual([expect.objectContaining({ name: "mail", outcome: "misconfigured" })]);
    expect(summary?.arms[0]!.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(summary?.pager).toBe("dead");
  });
});
