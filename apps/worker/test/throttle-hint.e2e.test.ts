import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * THE SERVER'S OWN BACKOFF HINT, WHICH THIS WORKER USED TO PARSE AND THROW AWAY.
 *
 * Office 365 answers a rate-limited command with `BAD Request is throttled. Suggested Backoff
 * Time: 92415 milliseconds`. imapflow parses that number out and hangs it on the error as
 * `err.throttleReset` (`imapflow@1.5.0/lib/imap-flow.js:853-863`) — and until this slice the
 * worker's `quarantineMailbox` computed its wait purely from its own exponential ladder, so a
 * provider that had said exactly when to come back was retried on our schedule instead. Being
 * early is what earns the next throttle.
 *
 * The unit is the trap and it is why these assertions are on EXACT milliseconds rather than
 * ranges: `throttleReset` is MILLISECONDS, assigned raw. Read as seconds it becomes a day-long
 * sleep; divided by 1000 it silently stops mattering at all. A range assertion would let both
 * through, so every case below pins the number.
 *
 * The contract in one line: the hint may only LENGTHEN the wait, and it may never escape
 * `retryMaxMs`. Each of the three arms below fails a different half of that, which is what makes
 * the pair `Math.max(…, hint)` / `Math.min(…, retryMaxMs)` individually load-bearing rather than
 * jointly green.
 *
 * Driven through the real worker rather than by calling a helper, because `quarantineMailbox` is
 * a closure over `retryBaseMs`/`retryMaxMs` inside `startWorker` — the `retryInMs` field of the
 * `mailbox_quarantined` log is the seam, the same one `mailbox-failure.e2e.test.ts` uses to tell
 * a growing backoff from a reset one.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 11));
let DB = "";

/**
 * EXPLICIT, AND NOT THE DEFAULT, BECAUSE THE DEFAULT IS 5 s AND THESE CASES SIT ON IT.
 *
 * `vitest.config.ts` sets no `testTimeout`, so every case here would inherit vitest's 5 000 ms.
 * Standing a real worker up and stopping it again costs roughly that on an idle machine, and
 * under several concurrent runs sharing this repo's one Postgres it goes over: an early run of
 * this file lost its FIRST case to the vitest timeout while the five after it passed, which reads
 * exactly like a logic failure and is not one. The budget is patience only — every assertion
 * below is an exact millisecond value and none of them move with it.
 */
const CASE_TIMEOUT_MS = 30_000;

type Db = ReturnType<typeof makeDb>;

async function seedMailbox(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
  }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

const closers: Array<() => Promise<void>> = [];

/**
 * Run one mailbox whose every `changesSince` throws `err`, and report the FIRST quarantine.
 *
 * First and not last on purpose: `attempts` is returned alongside so each case can assert it is
 * 1, which pins the ladder term to exactly `retryBaseMs`. Without that the expected values below
 * would be reading a moving number and "the hint lost" could not be told from "the ladder had
 * already climbed past it".
 */
async function firstQuarantine(
  err: unknown, retryBaseMs: number,
): Promise<{ retryInMs: number; attempts: number }> {
  const db = makeDb(DB);
  const fleet = new FakeAdapterFleet();
  const mb = await seedMailbox(db);
  // Connect, the lease gate, ensureFolders and IDLE all succeed; the mailbox is published and
  // then fails while being READ. That is the `sync` phase, the one a live throttle arrives in.
  fleet.behave(mb.mailboxId, { syncError: err });

  const seen: Array<{ retryInMs: number; attempts: number }> = [];
  const logger = {
    debug: () => { /* unused */ },
    info: () => { /* unused */ },
    warn: () => { /* unused */ },
    error: (event: string, detail?: Record<string, unknown>) => {
      if (event === "mailbox_quarantined" && typeof detail?.retryInMs === "number") {
        seen.push({ retryInMs: detail.retryInMs, attempts: Number(detail.attempts) });
      }
    },
    child() { return this; },
  };

  const cfg: WorkerConfig = {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 100, sentDomain: "trafficflow.test",
    rosterIntervalMs: 300, mailboxRetryMs: retryBaseMs,
    // High on purpose: this file is about the WAIT, and a mailbox disabled for repeated failure
    // would stop producing the event before the assertion could read it.
    maxSyncFailures: 50,
    lockHeartbeatMs: 150, instanceId: `wkr-throttle-${randomUUID().slice(0, 8)}`,
    adapterFactory: fleet.factory,
    logger,
  };

  const worker = await startWorker(cfg);
  closers.push(() => worker.stop());
  await waitFor(() => seen.length > 0, 20_000, "the mailbox was quarantined at least once");
  return seen[0]!;
}

/** A throttle exactly as imapflow builds it: `code`, and the raw millisecond number. */
function throttle(resetMs: number): Error & { code: string; throttleReset: number } {
  const err = new Error("Request is throttled. Suggested Backoff Time") as
    Error & { code: string; throttleReset: number };
  err.code = "ETHROTTLE";
  err.throttleReset = resetMs;
  return err;
}

describe("the server's suggested backoff wins, bounded by our ceiling", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_throttlehint"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  // ARM 1 — the hint is LONGER than the ladder, so the hint wins.
  //
  // Kills `Math.max`: without it the wait is the ladder's 300 ms and the provider that asked for
  // two seconds is dialled again after a fraction of one.
  it("waits the server's hint when it exceeds the ladder", async () => {
    const got = await firstQuarantine(throttle(2_000), 300);
    expect(got.attempts, "the first quarantine, so the ladder term is exactly retryBaseMs").toBe(1);
    expect(got.retryInMs).toBe(2_000);
  }, CASE_TIMEOUT_MS);

  // ARM 2 — the hint is SHORTER than the ladder, so the hint loses.
  //
  // Kills a "the hint always wins" implementation. The ladder is a floor: a provider throttling
  // us must never be able to talk this worker into retrying SOONER than its own backoff, and a
  // 100 ms hint on the third failure of a struggling host is exactly that request.
  it("keeps the ladder when the server's hint is shorter", async () => {
    const got = await firstQuarantine(throttle(100), 300);
    expect(got.attempts).toBe(1);
    expect(got.retryInMs).toBe(300);
  }, CASE_TIMEOUT_MS);

  // ARM 3 — the hint is ABOVE the ceiling, so it is capped.
  //
  // Kills `Math.min`: without it a mailbox is parked for whatever the far end said. 100 s against
  // a 4.8 s cap here; the real MS365 number is 92 s and nothing bounds it from the wire.
  it("caps the server's hint at retryMaxMs", async () => {
    const got = await firstQuarantine(throttle(100_000), 300);
    expect(got.attempts).toBe(1);
    // retryMaxMs is retryBaseMs * 16.
    expect(got.retryInMs).toBe(4_800);
  }, CASE_TIMEOUT_MS);

  // THE UNIT, ASSERTED ON ITS OWN. The three arms above all sit near a cap that would absorb a
  // 1000x error; this one does not. Base 10 s ⇒ ceiling 160 s, and imapflow's own documented
  // example value lands strictly between the two, so it is reported verbatim or not at all.
  // Read as seconds: 92_415_000, capped to 160_000. Divided by 1000: 92.415, floored to the
  // ladder's 10_000. Both are red here and both would be green against a range.
  it("treats throttleReset as milliseconds, verbatim", async () => {
    const got = await firstQuarantine(throttle(92_415), 10_000);
    expect(got.attempts).toBe(1);
    expect(got.retryInMs).toBe(92_415);
  }, CASE_TIMEOUT_MS);

  // A quarantine with NO hint still gets the untouched ladder. `backoffFor` must not have moved:
  // every error that is not a throttle — which is nearly all of them — has to behave exactly as
  // it did before this slice.
  it("leaves the ladder alone for an error carrying no hint", async () => {
    const got = await firstQuarantine(new Error("plain failure"), 300);
    expect(got.attempts).toBe(1);
    expect(got.retryInMs).toBe(300);
  }, CASE_TIMEOUT_MS);

  // A MALFORMED HINT MUST NOT STRAND THE MAILBOX. `Math.max(300, NaN)` is NaN, `retryAt` becomes
  // NaN, and `Date.now() >= NaN` is false FOREVER — the mailbox would never be retried again.
  // imapflow's `!isNaN` guard means it cannot send one today; this asserts the wait computation
  // does not depend on that remaining true.
  it("ignores a non-finite hint rather than stranding the mailbox", async () => {
    const got = await firstQuarantine(throttle(Number.NaN), 300);
    expect(Number.isFinite(got.retryInMs), `retryInMs was ${got.retryInMs}`).toBe(true);
    expect(got.retryInMs).toBe(300);
  }, CASE_TIMEOUT_MS);
});
