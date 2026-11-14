import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { isProviderRefusal } from "../src/mailboxes.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { ORGANIZER_CONSENT } from "./_workerdb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * a mail server's "not now" is not a broken mailbox (mail 0130).
 *
 * A throttle or an RFC 5530 UNAVAILABLE/LIMIT answer used to take `markMailboxFailed`, so the row
 * read `status='error'` and every surface said the mailbox had failed. Driven through the real
 * worker and its database: the row must stay `connected` with `provider_unavailable`, while a
 * plain failure and a refused password still write the error they always did.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 41));
let DB = "";
const CASE_TIMEOUT_MS = 30_000;
type Db = ReturnType<typeof makeDb>;

async function seedMailbox(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, ...ORGANIZER_CONSENT,
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

/** imapflow's throttle shape: `code`, the raw millisecond hint, and LOGIN's stamped flag. */
function throttle(resetMs: number): Error {
  return Object.assign(new Error("Request is throttled. Suggested Backoff Time"), {
    code: "ETHROTTLE", throttleReset: resetMs, authenticationFailed: true,
  });
}
/** A tagged `NO [<code>]` answer, as imapflow hangs it on the error. */
function refused(serverResponseCode: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`Command failed`), { serverResponseCode, ...extra });
}

const closers: Array<() => Promise<void>> = [];

type Row = typeof mailboxes.$inferSelect;

/**
 * One mailbox whose connect or every sync throws `err`; returns its row once the first
 * quarantine has been logged and written, plus the quarantine log's fields.
 */
async function quarantinedRow(
  err: unknown, phase: "attach" | "sync",
): Promise<{ row: Row; logged: Record<string, unknown>; db: Db; fleet: FakeAdapterFleet; mailboxId: string }> {
  const db = makeDb(DB);
  const fleet = new FakeAdapterFleet();
  const mb = await seedMailbox(db);
  fleet.behave(mb.mailboxId, phase === "attach" ? { connectError: err } : { syncError: err });
  const logged: Array<Record<string, unknown>> = [];
  const logger = {
    debug: () => undefined, info: () => undefined, warn: () => undefined,
    error: (event: string, detail?: Record<string, unknown>) => {
      if (event === "mailbox_quarantined") logged.push(detail ?? {});
    },
    child() { return this; },
  };
  const cfg: WorkerConfig = {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 100, sentDomain: "trafficflow.test",
    rosterIntervalMs: 200, mailboxRetryMs: 300, maxSyncFailures: 1, syncBlockGraceMs: 0,
    lockHeartbeatMs: 150, instanceId: `wkr-softfail-${randomUUID().slice(0, 8)}`,
    adapterFactory: fleet.factory, logger: logger as unknown as WorkerConfig["logger"],
  };
  const worker = await startWorker(cfg);
  closers.push(() => worker.stop());
  const read = async (): Promise<Row> =>
    (await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId)))[0]!;
  // The log line comes after the awaited write, so the row read after it is the written one.
  await waitFor(() => logged.length > 0, 20_000, "the mailbox was quarantined");
  return { row: await read(), logged: logged[0]!, db, fleet, mailboxId: mb.mailboxId };
}

describe("a provider's refusal is its own state, not a broken mailbox", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_softfail"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it.each([
    ["a throttle while reading", throttle(2_000), "sync"],
    ["a throttle at LOGIN, flag and all", throttle(2_000), "attach"],
    ["NO [UNAVAILABLE] while reading", refused("UNAVAILABLE"), "sync"],
    ["NO [LIMIT] at LOGIN", refused("LIMIT", { authenticationFailed: true }), "attach"],
  ] as const)("%s keeps the row connected and names provider_unavailable", async (_n, err, phase) => {
    const { row, logged } = await quarantinedRow(err, phase);
    expect(row.status, "a provider's refusal was written as a broken mailbox").toBe("connected");
    expect(row.errorCode).toBeNull();
    expect(row.syncBlockedReason).toBe("provider_unavailable");
    expect(row.syncBlockedSince).not.toBeNull();
    // The backoff is still real and still persisted — only the verdict moved.
    expect(row.retryAfter).not.toBeNull();
    expect(row.retryCount, "a refusal counted as a failure").toBe(0);
    // No read happened, so no progress is claimed for the lag alert.
    expect(row.syncProgressAt).toBeNull();
    expect(logged.syncBlockedReason).toBe("provider_unavailable");
    expect(logged.errorCode).toBeUndefined();
  }, CASE_TIMEOUT_MS);

  // THE POSITIVE CONTROLS: the arm is closed, so the errors it does not name keep their verdicts.
  it("a plain failure while reading still writes the error it always did", async () => {
    const { row, logged } = await quarantinedRow(new Error("socket said something odd"), "sync");
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("sync");
    expect(row.syncBlockedReason).toBeNull();
    expect(logged.errorCode).toBe("sync");
  }, CASE_TIMEOUT_MS);

  it("a refused password is still auth, not a provider's wait", async () => {
    const { row } = await quarantinedRow(
      refused("AUTHENTICATIONFAILED", { authenticationFailed: true }), "attach",
    );
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("auth");
    expect(row.syncBlockedReason).toBeNull();
  }, CASE_TIMEOUT_MS);

  it("a connection that merely failed stays the connect error — it cannot be told from an outage", async () => {
    const { row } = await quarantinedRow(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }), "attach",
    );
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("connect");
    expect(row.syncBlockedReason).toBeNull();
  }, CASE_TIMEOUT_MS);

  it("the block clears on the next completed cycle, with no restart", async () => {
    const { row, db, fleet, mailboxId } = await quarantinedRow(throttle(400), "sync");
    expect(row.syncBlockedReason, "nothing was blocked, so the clear below proves nothing").toBe("provider_unavailable");
    fleet.behave(mailboxId, { syncError: undefined });
    await waitFor(async () => {
      const r = (await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)))[0]!;
      return r.syncBlockedReason === null && r.lastSyncAt !== null;
    }, 20_000, "the refusal to clear once the server served a cycle");
    const r = (await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)))[0]!;
    expect(r.status).toBe("connected");
    expect(r.syncBlockedSince).toBeNull();
  }, CASE_TIMEOUT_MS);
});

describe("isProviderRefusal: what counts as the server saying not now", () => {
  it("names the three shapes and nothing else", () => {
    expect(isProviderRefusal(throttle(92_415))).toBe(true);
    expect(isProviderRefusal({ code: "ETHROTTLE" })).toBe(true);
    expect(isProviderRefusal({ throttleReset: 5_000 })).toBe(true);
    expect(isProviderRefusal(refused("UNAVAILABLE"))).toBe(true);
    expect(isProviderRefusal(refused("LIMIT"))).toBe(true);
    // A hint that is not a positive finite number is no hint.
    expect(isProviderRefusal({ throttleReset: Number.NaN })).toBe(false);
    expect(isProviderRefusal({ throttleReset: 0 })).toBe(false);
    // An atom the set does not contain falls through, the forged-token rule.
    expect(isProviderRefusal(refused("SECRETPASSWORD123"))).toBe(false);
    expect(isProviderRefusal(refused("OVERQUOTA"))).toBe(false);
    expect(isProviderRefusal(refused("AUTHENTICATIONFAILED"))).toBe(false);
    // A closed socket is an outage as far as anyone can tell.
    expect(isProviderRefusal({ code: "NoConnection" })).toBe(false);
    expect(isProviderRefusal({ code: "ECONNRESET" })).toBe(false);
    expect(isProviderRefusal(null)).toBe(false);
    expect(isProviderRefusal("ETHROTTLE")).toBe(false);
  });
});
