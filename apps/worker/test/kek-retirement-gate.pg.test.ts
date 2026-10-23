import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { accounts, users } from "@trafficflow/db";
import {
  makeDb, runKekRewrap, kekRewrapCensus, formatRetireStep, totpSecrets, staffUsers, oauthProviderConfig,
} from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { keyProviderFromEnv, kekEnvIdentity, kekRetiredThroughFromEnv } from "@trafficflow/core";
import type { WorkerConfig } from "../src/config.js";
import { runWorkerSupervised } from "../src/supervisor.js";
import { acquireLeaderLock, leaderLockKeyFor } from "../src/leader-lock.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import {
  keyRingVar, versionLabel as v, KEY_RING_PREFIX, KEY_RING_RETIRED,
} from "../../../test/support/key-ring-env.js";

/**
 * THE WORKER STARTS WITHOUT A RETIRED KEY VERSION ONLY WHEN NO STORED SECRET STILL NAMES IT.
 *
 * The last step of a rotation removes the old version from both hosts and declares it retired. The
 * environment alone cannot say whether that is safe: a stored secret the re-wrap did not move would
 * stay sealed under a key the host no longer holds, and the mailbox, the sign-in code or the OAuth
 * client behind it would fail at its first use. So the worker asks the database once at boot, BEFORE
 * its health endpoint answers and before the leader lock, and refuses to start while any envelope
 * names a retired version: the deployment then never goes live and the one it was replacing keeps
 * running. With nothing retired it asks nothing at all.
 *
 * Real envelopes from `@trafficflow/core` and a real re-wrap on a database of this file's own.
 */
const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));
const KEY_ONE = "a".repeat(64);
const KEY_TWO = "b".repeat(64);
const BOTH = { [keyRingVar(1)]: KEY_ONE, [keyRingVar(2)]: KEY_TWO };
const RETIRED = { [keyRingVar(2)]: KEY_TWO, [KEY_RING_RETIRED]: "1" };

let DB = "";

/** What `loadConfig` reads from the ring's environment, beside the fields a supervised boot needs. */
function cfgFrom(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    databaseUrl: DB,
    keyProvider: keyProviderFromEnv(env),
    kek: kekEnvIdentity(env),
    kekRetiredThrough: kekRetiredThroughFromEnv(env),
    pollIntervalMs: 1000, sentDomain: "trafficflow.test",
    healthPort: 0, standbyRetryMs: 400,
  };
}

async function health(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Three sealed secrets that start no mail connection, each under the first version by the product's own envelope code. */
async function seedUnderFirstVersion(db: ReturnType<typeof makeDb>): Promise<void> {
  const firstRing = keyProviderFromEnv({ [keyRingVar(1)]: KEY_ONE });
  const [a] = await db.insert(accounts).values({ name: "kek-retire" }).returning();
  const [u] = await db.insert(users).values({ accountId: a!.id, email: `${randomUUID()}@example.test` }).returning();
  const totp = await firstRing.encrypt("totp-secret");
  await db.insert(totpSecrets).values({
    userId: u!.id, secretEnc: totp.ciphertext, keyVersion: totp.keyVersion, activated: true,
  });
  const staff = await firstRing.encrypt("staff-totp");
  await db.insert(staffUsers).values({
    email: `staff-${randomUUID()}@example.test`, passwordHash: "scrypt-x-password-hash",
    totpSecretEnc: staff.ciphertext, totpKeyVersion: staff.keyVersion,
  });
  const client = await firstRing.encrypt("client-secret");
  await db.insert(oauthProviderConfig).values({
    provider: "microsoft", clientSecretEnc: client.ciphertext, clientSecretKeyVersion: client.keyVersion,
  });
}

/** Every stored secret, opened by `env`'s ring. */
async function openAll(db: ReturnType<typeof makeDb>, env: NodeJS.ProcessEnv): Promise<string[]> {
  const kp = keyProviderFromEnv(env);
  const [t] = await db.select().from(totpSecrets);
  const [s] = await db.select().from(staffUsers);
  const [o] = await db.select().from(oauthProviderConfig);
  return Promise.all([
    kp.decrypt(t!.secretEnc, t!.keyVersion),
    kp.decrypt(s!.totpSecretEnc!, s!.totpKeyVersion!),
    kp.decrypt(o!.clientSecretEnc!, o!.clientSecretKeyVersion!),
  ]);
}

describe("retiring a key version on the worker", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_kek_retire"); }, 180_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* already stopped */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("after a full re-wrap it boots on the second version alone, and every stored secret still opens", async () => {
    const db = makeDb(DB);
    await seedUnderFirstVersion(db);

    // The re-wrap, on the ring both hosts carry while it runs.
    const r = await runKekRewrap({ db: db as unknown as Tx, keyProvider: keyProviderFromEnv(BOTH), apply: true });
    expect(r.rewrapped).toBe(3);
    expect(r.failed).toBe(0);
    const census = await kekRewrapCensus(db as unknown as Tx, 2);
    expect(census.outstanding).toBe(0);
    // The step it prints is the one this test takes next.
    expect(formatRetireStep({ census, retiredThrough: 0, failed: r.failed }).join("\n"))
      .toContain(`set ${KEY_RING_RETIRED}=1 and delete ${keyRingVar(1)}`);

    // The first version removed and declared retired: the worker starts and leads.
    const sup = await runWorkerSupervised(cfgFrom(RETIRED));
    closers.push(() => sup.stop());
    expect(sup.state()).toBe("leader");
    const h = await health(sup.healthPort);
    expect(h.status).toBe(200);
    expect(h.body.kek).toEqual(kekEnvIdentity(RETIRED));
    expect((h.body.kek as { count: number }).count).toBe(1);

    expect(await openAll(db, RETIRED)).toEqual(["totp-secret", "staff-totp", "client-secret"]);
  });

  it("a secret still sealed under the first version refuses the boot: 503 from the first answer, no lock, the reason named", async () => {
    const db = makeDb(DB);
    await seedUnderFirstVersion(db);

    const fatal: unknown[] = [];
    const sup = await runWorkerSupervised(cfgFrom(RETIRED), { onFatal: (err) => fatal.push(err) });
    closers.push(() => sup.stop());

    expect(sup.state()).toBe("failed");
    expect(fatal).toHaveLength(1);
    const h = await health(sup.healthPort);
    expect(h.status).toBe(503);
    expect(h.body.leader).toBe(false);
    expect(h.body.healthy).toBe(false);
    const said = String(h.body.error);
    expect(said).toContain(`${KEY_RING_RETIRED}=1`);
    expect(said).toContain(`put ${keyRingVar(1)} back`);
    // The endpoint is public: it says what is wrong and how to fix it, never how many rows.
    expect(said).not.toMatch(/\b3\b/);

    // It never took the shard's lock, so the instance it was replacing kept it.
    const lock = await acquireLeaderLock(DB, leaderLockKeyFor(0));
    expect(lock).not.toBeNull();
    await lock!.release();

    // Nothing was written: the three secrets are still the first version's, and still open under a ring that holds it.
    expect((await kekRewrapCensus(db as unknown as Tx, 2)).sites.reduce((n, s) => n + (s.byVersion[1] ?? 0), 0)).toBe(3);
    expect(await openAll(db, BOTH)).toEqual(["totp-secret", "staff-totp", "client-secret"]);
  });

  /**
   * THE RUNNER ITSELF, as an operator (or a deploy wrapper) runs it: its own process, its ring from the
   * environment like a host's. What it prints is the procedure — the ring to compare with both hosts'
   * `/health`, every skipped row, the exact retire step, one summary line — so it is asserted here
   * rather than read off a template literal nobody runs.
   */
  it("the runner prints its ring, the exact retire step and one summary line, and moves every row", async () => {
    const db = makeDb(DB);
    await seedUnderFirstVersion(db);
    const run = (args: string[], ring: NodeJS.ProcessEnv) => new Promise<{ code: number; out: string }>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, TF_DB_URL: DB };
      // The ring is exactly the one named: nothing of the ring's prefix is inherited from this process.
      for (const k of Object.keys(env)) if (k.startsWith(KEY_RING_PREFIX)) delete env[k];
      const child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx/esm", "src/run-kek-rewrap.ts", ...args], {
        cwd: WORKER_DIR, env: { ...env, ...ring }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
      child.on("exit", (code) => resolve({ code: code ?? -1, out }));
    });
    const fingerprint = kekEnvIdentity(BOTH)!.fingerprint;

    const applied = await run(["--apply"], BOTH);
    expect(applied.code, applied.out).toBe(0);
    expect(applied.out).toContain(`Ring: 2 version(s) loaded, active ${v(2)}, fingerprint ${fingerprint}`);
    expect(applied.out).toContain("Re-wrapped 3.");
    expect(applied.out).toContain(`set ${KEY_RING_RETIRED}=1 and delete ${keyRingVar(1)}`);
    expect(applied.out).not.toContain("may now be removed");
    expect(applied.out.trimEnd().split("\n").at(-1))
      .toBe(`KEK_REWRAP apply target=${v(2)} outstanding=0 failed=0 truncated=0 fingerprint=${fingerprint}`);
    // No key material, in any spelling the run held it.
    expect(applied.out).not.toContain(KEY_ONE);
    expect(applied.out).not.toContain(KEY_TWO);

    // After the retirement the same runner, on the hosts' new ring, has nothing left to do or retire.
    const after = await run([], RETIRED);
    expect(after.code, after.out).toBe(0);
    expect(after.out).toContain(`versions up to ${v(1)} retired (${KEY_RING_RETIRED}=1)`);
    expect(after.out).toContain(`Nothing to retire: this ring holds only ${v(2)}`);
    expect(after.out.trimEnd().split("\n").at(-1))
      .toMatch(new RegExp(`^KEK_REWRAP dry target=${v(2)} outstanding=0 failed=0 truncated=0 `));
  }, 120_000);

  /**
   * THE ORDER IS THE GUARANTEE. A standby answers 200 from its first probe, so a gate asked after the
   * health endpoint is up leaves a window in which the platform reads the deployment healthy and retires
   * the instance it replaces. While the gate runs, nothing may answer on the health port yet.
   */
  it("the gate is asked before the health endpoint answers, so no probe ever reads 200 first", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const during: string[] = [];
    const sup = await runWorkerSupervised({ ...cfgFrom(RETIRED), healthPort: port }, {
      kekRetirementGate: async (_url, through) => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          during.push(`answered ${res.status}`);
        } catch {
          during.push("nothing listening");
        }
        return { retiredThrough: through, total: 1, versions: [1], sites: [] };
      },
    });
    closers.push(() => sup.stop());
    expect(during).toEqual(["nothing listening"]);
    expect(sup.state()).toBe("failed");
    expect((await health(sup.healthPort)).status).toBe(503);
  });

  it("with nothing retired the database is not asked, whatever the rows say", async () => {
    const db = makeDb(DB);
    await seedUnderFirstVersion(db);
    const asked: number[] = [];
    const sup = await runWorkerSupervised(cfgFrom(BOTH), {
      kekRetirementGate: async (_url, through) => { asked.push(through); throw new Error("not asked"); },
    });
    closers.push(() => sup.stop());
    expect(sup.state()).toBe("leader");
    expect(asked).toEqual([]);
  });
});
