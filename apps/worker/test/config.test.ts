import { describe, it, expect } from "vitest";
import { WORKER_NET_TIMEOUTS } from "@trafficflow/core/adapters/imap";
import { makePlatformSignalPort, SSE_DISABLED_REFUSAL } from "@trafficflow/db/cloud";
import {
  ATTACH_DEADLINE_MS, DEFAULT_ATTACH_CONCURRENCY, DEFAULT_SYNC_BLOCK_GRACE_MS, MAX_ATTACH_CONCURRENCY,
  WorkerConfigError, loadConfig, resolveAttachConcurrency,
} from "../src/config.js";
import { keyRingVar, KEY_RING_RETIRED } from "../../../test/support/key-ring-env.js";

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

describe("the 5xx poll's own credential, TF_SIGNAL_*", () => {
  const TOKEN = ["signal", "fixture", "value"].join("-");
  const TEAM = ["team", "fixture"].join("_");
  const PAIR = { ...BASE, TF_SIGNAL_VERCEL_TOKEN: TOKEN, TF_SIGNAL_VERCEL_TEAM_ID: TEAM };

  it("the worker's pair arms the poll; the API's VERCEL_* names arm nothing", () => {
    expect(loadConfig(BASE).signals).toBeUndefined();
    expect(loadConfig({ ...BASE, VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM }).signals).toBeUndefined();
    expect(loadConfig({ ...PAIR, TF_SIGNAL_PROJECTS: "ohmail-api,ohmail-web" }).signals).toEqual({
      env: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: TEAM, VERCEL_SIGNAL_PROJECTS: "ohmail-api,ohmail-web" },
      deliberate: [],
    });
  });

  it("TF_SIGNAL_SSE_OFF=1 counts the stream's 503 as deliberate, any other value counts it as an error", () => {
    expect(loadConfig({ ...PAIR, TF_SIGNAL_SSE_OFF: "1" }).signals?.deliberate).toEqual([SSE_DISABLED_REFUSAL]);
    for (const v of ["0", "true", ""]) {
      expect(loadConfig({ ...PAIR, TF_SIGNAL_SSE_OFF: v }).signals?.deliberate, v).toEqual([]);
    }
  });

  it("half a pair boots and builds a poll that asks nothing (the port answers unconfigured)", async () => {
    const window = { start: new Date(Date.now() - 600_000), end: new Date(Date.now() - 300_000) };
    for (const half of [{ TF_SIGNAL_VERCEL_TOKEN: TOKEN }, { TF_SIGNAL_VERCEL_TEAM_ID: TEAM, VERCEL_TOKEN: TOKEN }]) {
      const signals = loadConfig({ ...BASE, ...half }).signals;
      expect(signals, JSON.stringify(Object.keys(half))).toBeDefined();
      const asked: unknown[] = [];
      const port = makePlatformSignalPort(signals!.env, { fetchImpl: (async (u: unknown) => { asked.push(u); return new Response("{}"); }) as typeof fetch });
      expect(await port.fetch(window)).toEqual({ unconfigured: true });
      expect(asked).toEqual([]);
    }
  });
});

describe("the key ring's retired versions", () => {
  const KEY_ONE = "a".repeat(64);
  const KEY_TWO = "b".repeat(64);

  it("carries the declaration beside the ring, and nothing retired as 0", () => {
    const cfg = loadConfig({ ...BASE, [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1" });
    expect(cfg.kekRetiredThrough).toBe(1);
    expect(cfg.kek).toMatchObject({ active: 2, count: 1 });
    expect(cfg.keyProvider?.currentKeyVersion()).toBe(2);
    expect(loadConfig({ ...BASE, [keyRingVar(1)]: KEY_ONE }).kekRetiredThrough).toBe(0);
  });

  it("a ring the declaration contradicts refuses the boot with the loader's reason, never a key", () => {
    // Logged as `configVar` and `reason`: before, a ring refusal reached the log as its class alone, so a
    // worker refusing to start after a retirement said nothing about why.
    const e = refusal({ [keyRingVar(1)]: KEY_ONE, [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1" });
    expect(e.configVar).toBe(`${keyRingVar(1).slice(0, -1)}<n>`);
    expect(e.remedy).toContain(`${keyRingVar(1)} is set`);
    expect(`${e.message} ${e.remedy}`).not.toContain(KEY_ONE);
    expect(`${e.message} ${e.remedy}`).not.toContain(KEY_TWO);
  });
});
