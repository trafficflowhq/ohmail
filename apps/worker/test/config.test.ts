import { describe, it, expect } from "vitest";
import { WORKER_NET_TIMEOUTS } from "@trafficflow/core/adapters/imap";
import {
  ATTACH_DEADLINE_MS, DEFAULT_ATTACH_CONCURRENCY, DEFAULT_SYNC_BLOCK_GRACE_MS, MAX_ATTACH_CONCURRENCY,
  WorkerConfigError, loadConfig, resolveAttachConcurrency,
} from "../src/config.js";

/**
 * THE ATTACH POOL'S KNOBS (CLOUD-ROSTER-REATTACH-IS-SERIAL). The shipped defaults are asserted
 * here because every e2e guard injects its own, so a miswired default would pass the whole suite.
 */

const BASE = { DATABASE_URL_SESSION: "postgres://u:p@127.0.0.1:1/none" };

function refusal(env: Record<string, string>): WorkerConfigError {
  try {
    loadConfig({ ...BASE, ...env });
  } catch (e) {
    if (e instanceof WorkerConfigError) return e;
    throw e;
  }
  throw new Error("expected loadConfig to refuse");
}

describe("OHMAIL_BLANK_REPAIR", () => {
  it("reads the repair's mode, unset or empty as apply, and refuses any other value by name", () => {
    // The worker, the self-host organizer and the reconcile backstop all take their mode from here.
    expect(loadConfig(BASE).blankRepair).toBe("apply");
    expect(loadConfig({ ...BASE, OHMAIL_BLANK_REPAIR: "" }).blankRepair).toBe("apply");
    expect(loadConfig({ ...BASE, OHMAIL_BLANK_REPAIR: "off" }).blankRepair).toBe("off");
    expect(loadConfig({ ...BASE, OHMAIL_BLANK_REPAIR: "dry" }).blankRepair).toBe("dry");
    expect(loadConfig({ ...BASE, OHMAIL_BLANK_REPAIR: "apply" }).blankRepair).toBe("apply");
    // A mistyped `off` read as the default would repair: it refuses the boot instead.
    expect(refusal({ OHMAIL_BLANK_REPAIR: "of" }).configVar).toBe("OHMAIL_BLANK_REPAIR");
  });
});

describe("attach concurrency and deadline", () => {
  it("ships four at once, a ceiling of eight and a three-minute deadline", () => {
    expect(DEFAULT_ATTACH_CONCURRENCY).toBe(4);
    expect(MAX_ATTACH_CONCURRENCY).toBe(8);
    expect(ATTACH_DEADLINE_MS).toBe(180_000);
  });

  it("reads TF_ATTACH_CONCURRENCY and refuses one outside 1 to 8 by name", () => {
    expect(loadConfig(BASE).attachConcurrency).toBe(DEFAULT_ATTACH_CONCURRENCY);
    expect(loadConfig({ ...BASE, TF_ATTACH_CONCURRENCY: "6" }).attachConcurrency).toBe(6);
    for (const bad of ["0", "9", "x"]) {
      expect(refusal({ TF_ATTACH_CONCURRENCY: bad }).configVar, bad).toBe("TF_ATTACH_CONCURRENCY");
    }
  });

  it("clamps a programmatic value instead of honouring it", () => {
    expect(resolveAttachConcurrency(undefined)).toBe(DEFAULT_ATTACH_CONCURRENCY);
    expect(resolveAttachConcurrency(32)).toBe(MAX_ATTACH_CONCURRENCY);
    expect(resolveAttachConcurrency(0)).toBe(1);
    expect(resolveAttachConcurrency(2.5)).toBe(1);
    expect(resolveAttachConcurrency(2)).toBe(2);
  });

  it("never cuts one stalled command short of the transport's own timeouts", () => {
    const transport = WORKER_NET_TIMEOUTS.connectionMs + WORKER_NET_TIMEOUTS.greetingMs + WORKER_NET_TIMEOUTS.socketMs;
    expect(ATTACH_DEADLINE_MS).toBeGreaterThanOrEqual(transport);
  });

  it("gives up on an attach before the row's sync-block grace runs out", () => {
    expect(ATTACH_DEADLINE_MS).toBeLessThan(DEFAULT_SYNC_BLOCK_GRACE_MS);
  });
});
