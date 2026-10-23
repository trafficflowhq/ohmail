import { describe, it, expect, afterEach, vi } from "vitest";
import { KEY_RING_V1, KEY_RING_RETIRED, keyRingVar } from "../../../test/support/key-ring-env.js";
import { loadHostConfig, type HostConfig } from "../src/config.js";
import { buildDeps, kekRetirementFor, resetServices } from "../src/deps.js";

/**
 * THE API HOST WITH A RETIRED KEY VERSION. Its ring is the environment's (the retired-versions
 * declaration names the versions that left), and whether a stored secret still names one of them is
 * its database's: the host asks once per instance and `/health` answers 503 while one does, or while
 * it cannot tell.
 */
const KEY_ONE = "a".repeat(64);
const KEY_TWO = "b".repeat(64);

const cfgWith = (ring: Record<string, string>): HostConfig => loadHostConfig({
  // Never dialed: the reading below is injected.
  DATABASE_URL_POOLED: "postgres://ohmail_runtime@localhost:5432/x",
  ...ring,
} as NodeJS.ProcessEnv);

const at = new Request("https://api.ohmail.app/health");

afterEach(() => { vi.restoreAllMocks(); resetServices(); });

describe("the API host's ring after a retirement", () => {
  it("loads the second version alone once the first is declared retired, and arms the check", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cfg = cfgWith({ [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1" });
    expect(cfg.kekError).toBeNull();
    expect(cfg.kek).toMatchObject({ active: 2, count: 1 });
    expect(cfg.kekRetiredThrough).toBe(1);
    expect(cfg.keyProvider.currentKeyVersion()).toBe(2);
    expect(typeof buildDeps(at, cfg).health?.kekRetirement).toBe("function");
  });

  it("with nothing retired there is nothing to ask", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cfg = cfgWith({ [KEY_RING_V1]: KEY_ONE });
    expect(cfg.kekRetiredThrough).toBe(0);
    expect(buildDeps(at, cfg).health?.kekRetirement ?? null).toBeNull();
  });

  it("a retired version left set is a key fault, captured like any other: /health names it, nothing is armed", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cfg = cfgWith({ [KEY_RING_V1]: KEY_ONE, [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1" });
    expect(cfg.kek).toBeNull();
    expect(cfg.kekError).toContain(`${KEY_RING_V1} is set`);
    expect(cfg.kekError).not.toContain(KEY_ONE);
    expect(cfg.kekRetiredThrough).toBe(0);
    expect(buildDeps(at, cfg).health?.kekRetirement ?? null).toBeNull();
  });
});

describe("the check, once per instance", () => {
  const retired = () => cfgWith({ [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1" });

  it("a secret still on the first version is the 503's reason, asked once however often /health is read", async () => {
    const cfg = retired();
    let reads = 0;
    const check = kekRetirementFor(cfg, async (through) => {
      reads++;
      return { retiredThrough: through, total: 2, versions: [1], sites: [] };
    });
    const first = await check();
    expect(first?.error).toBe("kek_retired_version_in_use");
    expect(first?.detail).toContain(`put ${KEY_RING_V1} back`);
    expect(first?.detail).not.toMatch(/\b2\b/);
    expect(await check()).toEqual(first);
    expect(reads).toBe(1);
  });

  it("nothing on a retired version: no fault, and the answer is kept", async () => {
    const cfg = retired();
    let reads = 0;
    const check = kekRetirementFor(cfg, async (through) => {
      reads++;
      return { retiredThrough: through, total: 0, versions: [], sites: [] };
    });
    expect(await check()).toBeNull();
    expect(await check()).toBeNull();
    expect(reads).toBe(1);
  });

  it("a reading that fails is a fault of its own, and is asked again next time", async () => {
    const cfg = retired();
    let reads = 0;
    const check = kekRetirementFor(cfg, async (through) => {
      reads++;
      if (reads === 1) throw Object.assign(new Error("permission denied for table staff_users"), { code: "42501" });
      return { retiredThrough: through, total: 0, versions: [], sites: [] };
    });
    const first = await check();
    expect(first?.error).toBe("kek_retirement_unread");
    expect(first?.detail).toContain(`${KEY_RING_RETIRED}=1`);
    expect(first?.detail).not.toContain("staff_users");
    expect(await check()).toBeNull();
    expect(reads).toBe(2);
  });
});
