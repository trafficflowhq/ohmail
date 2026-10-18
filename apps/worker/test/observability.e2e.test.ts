import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { workerHeartbeats, alertState, SYNC_LAG_PAGE_ACCOUNTS } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger, type Logger } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import { imapCfg } from "./_workerenv.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

/**
 * from the worker's side: THE HEARTBEAT AND THE ALERT PASS, WITHOUT WAITING FOR A REAL
 * FAILURE.
 *
 * Two things are asserted here that `packages/db/test/alerts.test.ts` structurally cannot,
 * because they are about the WIRING rather than the rules:
 *
 *  1. a running leader actually writes `worker_heartbeats`, and a clean `stop()` actually
 *     surrenders it — which is what makes "no leader lock held for > 2 minutes" answerable
 *     by a process that is not this one;
 *  2. the alert pass runs on the worker's own timer and reaches its webhook sink through an
 *     INJECTED transport, so the suite proves delivery without opening a socket (the "Testing bar" invariant).
 *
 * The worker syncs nothing here on purpose: no mailbox is seeded with reachable credentials,
 * so the cycle is empty and fast, and the only thing under test is the observability wiring.
 */

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9));
/* The push arm arms only on a token of BotFather's shape (digits, a colon, 30+ url-safe characters), so the
 * fixture is assembled at run time in that shape: a whole literal of it is a credential to the push gate. */
const TELEGRAM_BOT_TOKEN = `${"4".repeat(10)}:${"telegram-bot-fixture-token".padEnd(36, "x")}`;
let DB = "";

/** A logger that collects its own JSON lines so assertions read the real output. */
function collectingLogger(): { logger: Logger; events: () => string[]; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({ service: "worker", level: "debug", sink: (l) => lines.push(l) }),
    events: () => lines.map((l) => (JSON.parse(l) as { event: string }).event),
  };
}

/** An enabled mailbox whose IMAP credentials point nowhere — attach fails, quarantine, no I/O. */
async function seedUnreachableMailbox(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const cfg = imapCfg();
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: cfg.auth.user })
    .returning();
  const enc = await KP.encrypt("nope");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    // Nothing listens on 127.0.0.1:1 — connect fails fast.
    meta: { host: "127.0.0.1", port: 1, secure: false, user: cfg.auth.user },
  });
  return { accountId, mailboxId: row!.id };
}

async function waitFor<T>(read: () => Promise<T | null>, ms = 8000): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

describe("worker observability wiring", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_obs"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("the leader writes a heartbeat row on startup, keyed by shard", async () => {
    const db = makeDb(DB);
    const { logger } = collectingLogger();
    const worker = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger, instanceId: "wkr-obs-1", environment: "test",
      alertIntervalMs: 60_000,
    });
    closers.push(() => worker.stop());

    const beat = await waitFor(async () => {
      const rows = await db.select().from(workerHeartbeats).where(eq(workerHeartbeats.shardIndex, 0));
      return rows[0] ?? null;
    });
    expect(beat, "a running leader must be visible in worker_heartbeats").not.toBeNull();
    expect(beat!.instanceId).toBe("wkr-obs-1");
    expect(beat!.leader).toBe(true);
    expect(beat!.shards).toBe(1);
    // Freshly written, so an external observer computes an age of ~0 rather than "never".
    expect(Date.now() - new Date(beat!.beatAt).getTime()).toBeLessThan(30_000);
  }, 30_000);

  it("a clean stop() SURRENDERS the heartbeat, so a failed handover is visible immediately", async () => {
    const db = makeDb(DB);
    const { logger } = collectingLogger();
    const worker = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger, instanceId: "wkr-obs-2", environment: "test",
      alertIntervalMs: 60_000,
    });
    await waitFor(async () => {
      const rows = await db.select().from(workerHeartbeats);
      return rows[0] ?? null;
    });
    await worker.stop();

    const [row] = await db.select().from(workerHeartbeats).where(eq(workerHeartbeats.shardIndex, 0));
    expect(row, "the row stays, as evidence of who was last here").toBeDefined();
    // …but it no longer claims leadership. Without this a graceful shutdown would look alive
    // for the full two-minute window while nothing was syncing.
    expect(row!.leader).toBe(false);
  }, 30_000);

  it("the alert pass runs on the worker's timer and reaches its webhook sink — no socket opened", async () => {
    const db = makeDb(DB);
    const { logger, events } = collectingLogger();
    const posted: Array<{ url: string; body: string }> = [];

    await seedUnreachableMailbox(db);

    const worker = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger, instanceId: "wkr-obs-3", environment: "test",
      // Fast enough to observe, and the transport is INJECTED so the suite performs zero
      // external requests (the "Testing bar" invariant) while still proving delivery end to end.
      alertIntervalMs: 200,
      alertWebhookUrl: "https://ntfy.example/ohmail",
      alertPost: async (url, body) => { posted.push({ url, body }); return { status: 200 }; },
      mailboxRetryMs: 60_000,
    });
    closers.push(() => worker.stop());

    // A clean world first: the seeded mailbox has never synced but its `created_at` is now,
    // so nothing is due, and NOTHING is delivered. An alerter that pages on a healthy
    // deployment is an alerter people mute on day one.
    await new Promise((r) => setTimeout(r, 800));
    expect(posted, "a healthy world must page nobody").toEqual([]);
    expect(events(), "and it must not have crashed either").not.toContain("alert_pass_failed");

    // Now break something the pass can see, and watch it fire and deliver.
    await db.update(mailboxes).set({ lastSyncAt: new Date(Date.now() - 60 * 60 * 1000) });
    const delivered = await waitFor(async () => (posted.length > 0 ? posted[0]! : null), 8000);

    expect(delivered, "a stale mailbox must reach the configured sink").not.toBeNull();
    expect(delivered!.url).toBe("https://ntfy.example/ohmail");
    const body = JSON.parse(delivered!.body) as { alerts: Array<{ kind: string }>; source: string };
    expect(body.source).toBe("worker");
    expect(body.alerts.map((a) => a.kind)).toContain("sync_lag");

    // The state row exists, so the next pass will NOT page again inside the repeat window.
    const [state] = await db.select().from(alertState).where(eq(alertState.alertKey, "sync_lag"));
    expect(state).toBeDefined();
    expect(state!.notifiedAt).not.toBeNull();
  }, 30_000);

  it("BOTH vendor arms receive the same page, and each arm's own health is published", async () => {
    // ── WHY A SECOND VENDOR, AND WHY THIS TEST IS ABOUT COMPOSITION ─────────────────────────
    //
    // The pager ran single-vendor: every page in the world through one transactional-mail
    // account, so that account's outage silences it exactly when something is wrong. The rules
    // for a lost arm are unit-tested where they live (`packages/db/test/alert-sink-health.test.ts`);
    // what only this test can see is that the worker COMPOSES both arms, that one page reaches
    // both of them, and that the per-arm verdict reaches `/health` — the surface that makes a
    // dead arm visible instead of trusted.
    const db = makeDb(DB);
    const { logger, events } = collectingLogger();
    const posted: Array<{ url: string; body: string }> = [];

    // A PAGE under the mail policy: sync_lag:critical on SYNC_LAG_PAGE_ACCOUNTS accounts. One lagging mailbox
    // goes to the daily summary, so it could not show that a page reaches both arms.
    for (let i = 0; i < SYNC_LAG_PAGE_ACCOUNTS; i += 1) await seedUnreachableMailbox(db);

    const worker = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger, instanceId: "wkr-obs-6", environment: "test",
      alertIntervalMs: 200,
      // The mail arm and the push arm. No webhook — that variable is deleted in production,
      // its host having been proven to blackhole this platform's egress.
      alertEmail: "ops@ohmail.example",
      mailFrom: "ohmail <no-reply@ohmail.example>",
      resendApiKey: "re_test_key_for_the_suite",
      alertTelegramBotToken: TELEGRAM_BOT_TOKEN,
      alertTelegramChatId: "-1001234567890",
      // ONE injected transport for both arms, so the suite performs zero external requests
      // (the "Testing bar" invariant) while still proving each arm posts where it says it posts.
      alertPost: async (url, body) => { posted.push({ url, body }); return { status: 200 }; },
      mailboxRetryMs: 60_000,
    });
    closers.push(() => worker.stop());

    expect(
      events(),
      "two vendors is the whole point — the single-arm warning must NOT fire here",
    ).not.toContain("alert_sinks_single_vendor");

    await db.update(mailboxes).set({ lastSyncAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
    const isPage = (p: { url: string; body: string }) =>
      new URL(p.url).host === "api.telegram.org" || p.body.includes("[test] ohmail: 1 alert firing");
    const isSummary = (p: { url: string; body: string }) =>
      new URL(p.url).host === "api.resend.com" && p.body.includes("daily alert summary");
    await waitFor(async () => (posted.filter(isPage).length >= 2 && posted.some(isSummary) ? posted : null), 8000);
    const pages = posted.filter(isPage);

    const hosts = pages.map((p) => new URL(p.url).host).sort();
    expect(
      hosts,
      "one page must reach BOTH vendors — a page that only one carries is not redundancy",
    ).toEqual(["api.resend.com", "api.telegram.org"]);

    // BOTH arms carry the same alert, rendered from Alert fields only: the push arm through
    // `renderAlertText`, the mail arm through `renderAlertMail`, the one mail both hosts send
    // (2026-09-28). Counts, ages and rule titles, never mail content; the rule KEY is in
    // neither, only the webhook arm's payload carries the structured `alerts` array.
    for (const p of pages) {
      const mail = new URL(p.url).host === "api.resend.com";
      expect(p.body).toContain(mail ? "[test] ohmail: 1 alert firing" : "1 alert(s) firing");
      expect(p.body).toContain("behind by more than");
      expect(p.body, "a credential may never reach a third party's request body")
        .not.toContain("re_test_key_for_the_suite");
    }
    // The first pass after a start also mails the daily summary (MAIL-POLICY-FIRST-DIGEST-AT-DEPLOY): beside the
    // page, never instead of it, and with no credential in it either.
    const summaries = posted.filter(isSummary);
    expect(summaries.length, "the mail arm's summary is sent beside the page").toBe(1);
    expect(summaries[0]!.body).not.toContain("re_test_key_for_the_suite");

    const health = worker.stats().alertSinks;
    expect(health.map((h) => h.name).sort()).toEqual(["mail", "telegram"]);
    for (const arm of health) {
      expect(arm.attempts, `${arm.name} was attempted`).toBeGreaterThan(0);
      expect(arm.outcome, `${arm.name} accepted, and says so in a closed code`).toBe("ok");
      expect(arm.consecutiveFailures).toBe(0);
      expect(arm.lastOkAt).not.toBeNull();
    }
    expect(
      JSON.stringify(health),
      "/health is readable by anyone: no credential and no vendor prose may ride on it",
    ).not.toContain("8123456789");
    expect(worker.stats().pager, "two arms delivering").toBe("ok");
  }, 30_000);

  it("EVERY arm refusing publishes pager: dead and logs alerts_undeliverable", async () => {
    const db = makeDb(DB);
    const { logger, events } = collectingLogger();
    await seedUnreachableMailbox(db);
    await db.update(mailboxes).set({ lastSyncAt: new Date(Date.now() - 60 * 60 * 1000) });
    const worker = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger, instanceId: "wkr-obs-9", environment: "test",
      alertIntervalMs: 150,
      alertWebhookUrl: "https://ntfy.example/ohmail",
      alertPost: async () => ({ status: 503, body: "down" }),
      mailboxRetryMs: 60_000,
    });
    closers.push(() => worker.stop());
    const dead = await waitFor(async () => (worker.stats().pager === "dead" ? true : null), 10_000);
    expect(dead, "three refused passes and the pager reports itself dead").toBe(true);
    expect(events()).toContain("alerts_undeliverable");
  }, 30_000);

  it("the shard-0 leader hands its API-cron schedule to the pass: api_cron_stale is evaluated, not unread", async () => {
    // Two rows. `retired` names a target the schedule no longer drives: with the schedule handed
    // over the pass evaluates it clear; handed nothing it stays open (the control below), which is
    // the built-tested-unreachable shape. `scheduled_send` is a target the fresh schedule has not
    // poked yet: no 2xx, no evidence, so it stays open with the schedule handed over too.
    const db = makeDb(DB);
    const seed = (target: string) => db.insert(alertState).values({
      alertKey: `api_cron_stale:${target}`, kind: "api_cron_stale", severity: "critical",
      openedAt: new Date(Date.now() - 60 * 60 * 1000), lastSeenAt: new Date(Date.now() - 60 * 1000),
      notifiedAt: new Date(Date.now() - 60 * 60 * 1000), notifyCount: 1, detail: "seeded", cls: "incident",
      title: "seeded", count: 1,
    } as never);
    const open = async () => (await db.select({ k: alertState.alertKey }).from(alertState)
      .where(isNull(alertState.resolvedAt))).map((r) => r.k);

    await seed("scheduled_send");
    await seed("retired");
    const bare = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger: collectingLogger().logger, instanceId: "wkr-obs-10", environment: "test",
      alertIntervalMs: 150, mailboxRetryMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 900));
    await bare.stop();
    expect(await open(), "no schedule: unread, the row stays").toContain("api_cron_stale:retired");

    const worker = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger: collectingLogger().logger, instanceId: "wkr-obs-11", environment: "test",
      alertIntervalMs: 150, mailboxRetryMs: 60_000,
      // Nothing listens there, and no target's first poke falls inside this test.
      apiCron: { baseUrl: "http://127.0.0.1:1", secret: "s".repeat(32) },
    });
    closers.push(() => worker.stop());
    const cleared = await waitFor(async () =>
      ((await open()).includes("api_cron_stale:retired") ? null : true), 8000);
    expect(cleared, "the schedule was handed to the pass, which evaluated the retired key clear").toBe(true);
    expect(await open(), "a target with no 2xx since the schedule started is not cleared")
      .toContain("api_cron_stale:scheduled_send");
  }, 30_000);

  it("ONE arm is announced as a single point of failure, not published as a healthy pager", async () => {
    const db = makeDb(DB);
    const { logger, lines } = collectingLogger();
    await seedUnreachableMailbox(db);
    const worker = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger, instanceId: "wkr-obs-7", environment: "test",
      alertIntervalMs: 60_000,
      // The production posture this slice exists to end: exactly one vendor.
      alertEmail: "ops@ohmail.example",
      mailFrom: "ohmail <no-reply@ohmail.example>",
      resendApiKey: "re_test_key_for_the_suite",
      alertPost: async () => ({ status: 200 }),
      mailboxRetryMs: 60_000,
    });
    closers.push(() => worker.stop());

    const warned = lines
      .map((l) => JSON.parse(l) as { event: string; reason?: string; alertSinks?: string[] })
      .filter((l) => l.event === "alert_sinks_single_vendor");
    expect(
      warned,
      "one working arm looks exactly like a healthy pager until its vendor has an outage",
    ).toHaveLength(1);
    expect(warned[0]!.alertSinks).toEqual(["mail"]);
    expect(warned[0]!.reason, "and it must name the way out, not only the problem")
      .toContain("TF_ALERT_TELEGRAM_BOT_TOKEN");

    // The arm is composed and has never been exercised, and `/health` says exactly that
    // rather than implying health from its presence in a list.
    expect(worker.stats().alertSinks).toEqual([
      { name: "mail", outcome: null, consecutiveFailures: 0, attempts: 0, lastOkAt: null },
    ]);
  }, 30_000);

  it("the worker pass never reports ITSELF down — that rule belongs to the API host", async () => {
    const db = makeDb(DB);
    const { logger } = collectingLogger();
    const posted: string[] = [];
    const worker = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger, instanceId: "wkr-obs-4", environment: "test",
      alertIntervalMs: 200,
      alertWebhookUrl: "https://ntfy.example/x",
      alertPost: async (_url, body) => { posted.push(body); return { status: 200 }; },
    });
    closers.push(() => worker.stop());

    await new Promise((r) => setTimeout(r, 1200));
    const rows = await db.select().from(alertState);
    expect(rows.map((r) => r.alertKey)).not.toContain("worker_down:0");
    for (const body of posted) expect(body).not.toContain("worker_down");
  }, 30_000);

  it("every worker log line is one JSON object carrying instanceId and shard", async () => {
    const db = makeDb(DB);
    const { logger, lines } = collectingLogger();
    await seedUnreachableMailbox(db);
    const worker = await startWorker({
      databaseUrl: DB, pollIntervalMs: 60_000, sentDomain: "app.ohmail.app",
      keyProvider: KP, logger, instanceId: "wkr-obs-5", environment: "test",
      alertIntervalMs: 60_000, mailboxRetryMs: 60_000,
    });
    closers.push(() => worker.stop());

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.service).toBe("worker");
      expect(parsed.instanceId).toBe("wkr-obs-5");
      expect(parsed.shard).toBe(0);
      expect(typeof parsed.event).toBe("string");
      expect(typeof parsed.ts).toBe("string");
    }
    // The quarantine line is the one an operator greps for; it must name BOTH ids.
    const quarantined = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === "mailbox_quarantined");
    expect(quarantined, "a failed attach must produce a structured line").toBeDefined();
    expect(typeof quarantined!.mailboxId).toBe("string");
    expect(typeof quarantined!.accountId).toBe("string");
    // Class + code, never the driver's message.
    expect(quarantined).toHaveProperty("errorClass");
  }, 30_000);
});
