import { describe, it, expect, afterEach, vi } from "vitest";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";
import { loadHostConfig, type HostConfig } from "../src/config.js";
import { buildDeps, resetServices } from "../src/deps.js";

/**
 * THE CONNECT REMINDER SHIPS LOG-ONLY on the managed host: the lifecycle pass names what it would send
 * and writes nothing, until `TF_CONNECT_REMINDER=send`. Any other value is log-only, never a guess. `send`
 * reminds only trials begun at or after `TF_CONNECT_REMINDER_SINCE`, and nothing without it.
 */
const cfgWith = (extra: Record<string, string>): HostConfig => loadHostConfig({
  // Never dialed.
  DATABASE_URL_POOLED: "postgres://ohmail_runtime@localhost:5432/x",
  [KEY_RING_V1]: "ab".repeat(32),
  ...extra,
} as NodeJS.ProcessEnv);

afterEach(() => { vi.restoreAllMocks(); resetServices(); });

describe("TF_CONNECT_REMINDER on the managed host", () => {
  it("send sends; unset, empty or any other word logs only; every request's deps carry it", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const [value, mode] of [
      [null, "log"], ["", "log"], ["log", "log"], ["1", "log"], ["SEND", "log"], ["send", "send"], [" send ", "send"],
    ] as const) {
      const cfg = cfgWith(value === null ? {} : { TF_CONNECT_REMINDER: value });
      expect(cfg.connectReminder, String(value)).toBe(mode);
      expect(buildDeps(new Request("https://ohmail.app/internal/account-lifecycle/run"), cfg).connectReminder).toBe(mode);
    }
  });

  it("TF_CONNECT_REMINDER_SINCE reaches the pass as written, trimmed, and null unset or blank; the pass judges it", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const [value, since] of [
      [null, null], ["", null], ["   ", null],
      [" 2026-10-25T18:00:00Z ", "2026-10-25T18:00:00Z"], ["2026-10-25", "2026-10-25"],
    ] as const) {
      const cfg = cfgWith({ TF_CONNECT_REMINDER: "send", ...(value === null ? {} : { TF_CONNECT_REMINDER_SINCE: value }) });
      expect(cfg.connectReminderSince, String(value)).toBe(since);
      expect(buildDeps(new Request("https://ohmail.app/internal/account-lifecycle/run"), cfg).connectReminderSince).toBe(since);
    }
  });
});
