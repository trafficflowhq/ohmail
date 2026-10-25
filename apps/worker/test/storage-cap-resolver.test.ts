import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { UNMETERED, type EntitlementsPort } from "@trafficflow/db";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeStorageCapResolver } from "../src/storage-cap.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * THE HOSTED WORKER IS THE METERED COMPOSITION — the resolver's own behavior, and the pin that
 * keeps the composition wired.
 *
 * The resolver is mocked at the `storageCapOf` seam (`@trafficflow/db/cloud`) because what is
 * under test here is the RESOLUTION policy, not the subscription read — `storage-cloud.pg.test.ts`
 * owns that against real Postgres.
 *
 * The composition pin at the bottom is a SOURCE census, the log-census shape: `index.ts` is a
 * closure this suite cannot instantiate (it dials Railway env, IMAP, LISTEN), so the pin reads
 * the file and asserts the cycle spread and the attach-time deps both utter `storageCapFor` —
 * the mutation "flip the hosted composition to UNMETERED_STORAGE_CAP" turns exactly this red,
 * which was watched. It is deliberately a NAME census, not a behavior probe: the name is the
 * declaration, and the declaration is what the absent-config rule demands exist in the file.
 *
 * The CAP itself comes from the entitlements port's `access` now, not from a subscription row —
 * so the cases above hand the resolver a port rather than mocking a database read, and one of
 * them hands it `UNMETERED`, which is the composition a self-hosted organizer makes.
 */
const silent = { warn: () => {} };

/** A port that answers a cap, or throws — the two shapes the resolver must handle. */
function portFor(answers: Array<number | null | "throw">): {
  port: EntitlementsPort; calls: () => number;
} {
  let n = 0;
  const port: EntitlementsPort = {
    async access(_accountId: string) {
      const a = answers[Math.min(n++, answers.length - 1)];
      if (a === "throw") throw new Error("pooler blip");
      return { ok: true, limits: { mailboxes: null, storageBytes: a, canAddMailbox: true, aiEnabled: true } };
    },
    async accessOrFault(): Promise<"fault"> { return "fault"; },
    async spend() { return { verdict: "fault" }; },
    async release(): Promise<"settled"> { /* the resolver never spends */ return "settled"; },
    async manageLink() { return null; },
    async releaseAccount() { return "none"; },
  };
  return { port, calls: () => n };
}

describe("makeStorageCapResolver", () => {
  it("a metered account resolves to its NUMBER, cached for the TTL", async () => {
    const { port, calls } = portFor([5_000_000_000]);
    let t = 0;
    const resolve = makeStorageCapResolver(port, silent, { ttlMs: 30_000, now: () => new Date(t) });
    expect(await resolve("a1")).toBe(5_000_000_000);
    t = 29_000;
    expect(await resolve("a1")).toBe(5_000_000_000);
    expect(calls()).toBe(1);              // the cache held within the TTL
    t = 31_000;
    await resolve("a1");
    expect(calls()).toBe(2);              // …and expired past it
  });

  it("an UNBOUNDED limit (null) maps to the typed unmetered value", async () => {
    const { port } = portFor([null]);
    const resolve = makeStorageCapResolver(port, silent);
    expect(await resolve("a2")).toBe(UNMETERED_STORAGE_CAP);
  });

  it("an UNMETERED host resolves unmetered without dialling anything", async () => {
    const resolve = makeStorageCapResolver(UNMETERED, silent);
    expect(await resolve("a2b")).toBe(UNMETERED_STORAGE_CAP);
  });

  it("a read FAULT resolves unmetered for THIS resolution only — logged, never cached", async () => {
    const { port } = portFor(["throw", 1_000]);
    const lines: string[] = [];
    const resolve = makeStorageCapResolver(port, { warn: (e: string) => { lines.push(e); } });
    // The blip must not start withholding a paying customer's bodies…
    expect(await resolve("a3")).toBe(UNMETERED_STORAGE_CAP);
    expect(lines).toContain("storage_cap_read_failed");
    // …and must not stick: the next resolution asks again and gets the real cap.
    expect(await resolve("a3")).toBe(1_000);
  });

  it("inside a trial's storage floor the plan's own limit rides the same read; none at or above the cap", async () => {
    const answers = new Map<string, { storageBytes: number; plan?: number } | "throw">([
      ["solo-trial", { storageBytes: 4_000_000_000, plan: 2_000_000_000 }],
      ["plus-trial", { storageBytes: 5_000_000_000, plan: 5_000_000_000 }],
      ["paid", { storageBytes: 2_000_000_000 }],
      ["blip", "throw"],
    ]);
    let calls = 0;
    const { port: base } = portFor([null]);
    const port: EntitlementsPort = {
      ...base,
      async access(accountId: string) {
        calls += 1;
        const a = answers.get(accountId)!;
        if (a === "throw") throw new Error("pooler blip");
        return {
          ok: true, limits: { mailboxes: null, storageBytes: a.storageBytes, canAddMailbox: true, aiEnabled: true },
          ...(a.plan !== undefined ? { trialStorage: { planBytesLimit: a.plan, until: null } } : {}),
        };
      },
    };
    const resolve = makeStorageCapResolver(port, silent);
    expect(await resolve("solo-trial")).toBe(4_000_000_000);
    expect(await resolve.planLimit("solo-trial")).toBe(2_000_000_000);
    expect(calls, "the plan's limit asked the program again").toBe(1);
    expect(await resolve.planLimit("plus-trial")).toBeNull();
    expect(await resolve.planLimit("paid")).toBeNull();
    // A fault answers no plan limit, beside the unmetered cap that refills nothing.
    expect(await resolve.planLimit("blip")).toBeNull();
  });
});

describe("the hosted composition utters the resolver — the wiring pin", () => {
  it("index.ts threads storageCapFor at attach AND refreshes it in the cycle spread", () => {
    const src = readFileSync(join(HERE, "..", "src", "index.ts"), "utf8");
    // Comments are prose, not wiring: the CODE census below must not be satisfiable — or
    // refusable — by a docblock, so they are stripped before the name checks.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    // The construction…
    expect(code).toContain("makeStorageCapResolver(");
    // …the attach-time base deps…
    expect(code).toContain("storageCap: await storageCapFor(mb.accountId)");
    // …and the per-cycle refresh in the runSyncCycle spread.
    expect(code).toContain("storageCap: await storageCapFor(rt.accountId)");
    // The hosted composition NEVER types the unmetered constant — that word belongs to the
    // sidecar, the self-host server and the tests, and its appearance here would be the silent
    // unmetering this pin exists to refuse.
    expect(code).not.toContain("UNMETERED_STORAGE_CAP");
  });

  it("the reconcile-cron backstop is metered through the same resolver", () => {
    const src = readFileSync(join(HERE, "..", "src", "reconcile-cron.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");
    expect(code).toContain("makeStorageCapResolver(");
    expect(code).not.toContain("UNMETERED_STORAGE_CAP");
  });
});
