import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials, messages, folderState, accounts, rules, contacts } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger, type ClassifierPort, type Logger } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { ORGANIZER_CONSENT } from "./_workerdb.js";
import type { WorkerConfig } from "../src/config.js";

/**
 * **AN ANTHROPIC OUTAGE MUST NOT STOP MAIL.**
 *
 * This is the test the whole circuit breaker exists for, and it asserts the product's promise
 * rather than the mechanism: "rules with no AI at all run first and are meant to handle most
 * mail". Against a model that NEVER answers, the worker must still
 *
 *   · ingest the message,
 *   · file it where the deterministic rules say, and
 *   · leave the mailbox `connected` — never `status='error'`.
 *
 * The money arm left with the metering: this install answers UNMETERED, so an outage costs
 * nothing to ask about. What a metered caller does with each spend verdict — including the
 * deliberate absence of a refund on a classifier throw, because the retry is free — is driven
 * against the port double in `packages/core/test/pipeline.credits.test.ts`.
 *
 * Without the breaker every one of those fails: `pipeline.ts` rethrows the classifier fault,
 * which aborts the whole batch (the message is never ingested and the cursor never advances),
 * and `cycle()` counts the throw toward `maxSyncFailures` — so after three polls of a
 * third-party API the mailbox is DETACHED and marked broken.
 */

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 9));
let DB = "";

function collectingLogger(): { logger: Logger; events: () => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  return {
    logger: createLogger({ service: "worker", level: "debug", sink: (l) => lines.push(l) }),
    events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** A model that is simply gone — the shape of a provider incident. */
const DEAD_CLASSIFIER: ClassifierPort = {
  async classify(): Promise<never> { throw new Error("anthropic 529 overloaded_error"); },
};

async function until<T>(label: string, fn: () => Promise<T | null>, ms = 15_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

async function seedAccount(db: Db): Promise<{ accountId: string; mailboxId: string }> {
  const [acct] = await db.insert(accounts).values({ name: "outage" }).returning();
  const accountId = acct!.id;
  // The RULE that must keep working while the model is down.
  await db.insert(rules).values({
    accountId, kind: "domain", match: "newsletter.test", destination: "ohmail/News", priority: 5,
  });
  // A KNOWN sender that no rule matches. `evaluateRules` answers `unclear` for exactly this
  // shape — not a rule hit, not bulk, not first contact — which is the ONLY residue that
  // reaches the AI branch. Without a case like it the classifier is never called at all and an
  // outage test proves nothing.
  await db.insert(contacts).values({ accountId, address: "bob@known.test" });
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `o-${randomUUID().slice(0, 8)}@tf.test`, ...ORGANIZER_CONSENT }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "127.0.0.1", port: 3143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: mb!.id };
}

function cfgFor(fleet: FakeAdapterFleet, extra: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 150, sentDomain: "trafficflow.test",
    rosterIntervalMs: 10_000, mailboxRetryMs: 300, maxSyncFailures: 2,
    lockHeartbeatMs: 60_000, healthPort: 0, adapterFactory: fleet.factory,
    ...extra,
  };
}

describe("a dead model degrades to rules-only routing and never breaks a mailbox", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_outage"); }, 60_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("delivers and FILES the mail by rules, keeps the mailbox connected, and refunds the abandoned credit", async () => {
    const db = makeDb(DB);
    const { accountId, mailboxId } = await seedAccount(db);
    const fleet = new FakeAdapterFleet();
    // TWO messages, because the two halves of the claim need different mail:
    //  · anna matches the domain RULE, so `decision.destination != null` and `pipeline.ts`
    //    never consults the AI for her — she is the proof that rules keep filing mail.
    //  · bob is a KNOWN sender no rule matches, which is the `unclear` residue that DOES reach
    //    the AI branch — he is the one whose classification the dead model must fail.
    fleet.behave(mailboxId, {
      deliver: [
        { from: "anna@newsletter.test", subject: "Weekly", messageId: `m-${randomUUID()}` },
        { from: "bob@known.test", subject: "Question", messageId: `m-${randomUUID()}` },
      ],
    });
    const { logger, events } = collectingLogger();

    const w = await startWorker(cfgFor(fleet, { classifier: DEAD_CLASSIFIER, logger }));
    closers.push(() => w.stop());

    // 1. BOTH MESSAGES ARRIVE, even though the classifier never answers once. This is the
    //    claim: an Anthropic incident costs the AI suggestion, never the mail.
    const anna = await until("the rule-matched message to be ingested", async () => {
      const [m] = await db.select().from(messages)
        .where(and(eq(messages.mailboxId, mailboxId), eq(messages.fromAddress, "anna@newsletter.test")));
      return m ?? null;
    });
    const bob = await until("the AI-residue message to be ingested rules-only", async () => {
      const [m] = await db.select().from(messages)
        .where(and(eq(messages.mailboxId, mailboxId), eq(messages.fromAddress, "bob@known.test")));
      return m ?? null;
    });

    // 2. THE RULE STILL FILES — "rules with no AI at all run first", discharged.
    const [annaFs] = await db.select().from(folderState).where(eq(folderState.messageId, anna.id));
    expect(annaFs!.desiredFolder).toBe("ohmail/News");
    // ...and the message the model WOULD have routed is filed by the rules-only fallback
    // (left where it arrived) rather than being held hostage to the outage.
    const [bobFs] = await db.select().from(folderState).where(eq(folderState.messageId, bob.id));
    expect(bobFs!.desiredFolder).toBe("INBOX");

    // 3. THE MAILBOX IS NOT BROKEN. This is the assertion the breaker exists for: without it,
    //    two consecutive classifier faults reach `maxSyncFailures` and write `status='error'`.
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mb!.status).not.toBe("error");

    // 4. THE CIRCUIT REPORTED ITSELF, so an operator can see WHY the AI went quiet.
    const evts = events();
    expect(evts.some((e) => e.event === "classifier_circuit_open")).toBe(true);
    // ...and the model faults were logged as model faults, never as mailbox sync failures.
    expect(evts.some((e) => e.event === "sync_cycle_classifier_fault")).toBe(true);
    expect(evts.some((e) => e.event === "mailbox_quarantined")).toBe(false);

  }, 40_000);

  it("a mailbox whose FIRST sync faults on the model still attaches and serves", async () => {
    const db = makeDb(DB);
    const { mailboxId } = await seedAccount(db);
    const fleet = new FakeAdapterFleet();
    fleet.behave(mailboxId, {
      deliver: [{ from: "bob@newsletter.test", subject: "Hi", messageId: `m-${randomUUID()}` }],
    });
    const { logger, events } = collectingLogger();

    // An Anthropic incident during a DEPLOY must not mark every mailbox broken at once. Where
    // that is enforced MOVED with that change and got stronger for it: the first sync used to run
    // inside `attach`, which needed its own `ClassifierFaultError` arm (a second copy of the
    // exemption, on a path that could quarantine). Attach no longer syncs, so the first drain
    // faults in `cycle()` and is exempted there — one arm, on the path that owns
    // `maxSyncFailures`. The claim this test makes is unchanged: the mailbox attaches, serves,
    // ingests the message rules-only, and is never quarantined for somebody else's outage.
    const w = await startWorker(cfgFor(fleet, { classifier: DEAD_CLASSIFIER, logger }));
    closers.push(() => w.stop());

    await until("the message to be ingested despite the attach-time fault", async () => {
      const [m] = await db.select().from(messages)
        .where(and(eq(messages.mailboxId, mailboxId), eq(messages.fromAddress, "bob@newsletter.test")));
      return m ?? null;
    });

    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(mb!.status).not.toBe("error");
    expect(events().some((e) => e.event === "mailbox_quarantined")).toBe(false);
  }, 40_000);

  it("CONTROL — a genuine adapter failure still quarantines, so the exemption is narrow", async () => {
    const db = makeDb(DB);
    const { mailboxId } = await seedAccount(db);
    const fleet = new FakeAdapterFleet();
    const { logger } = collectingLogger();

    const w = await startWorker(cfgFor(fleet, { classifier: DEAD_CLASSIFIER, logger }));
    closers.push(() => w.stop());
    await until("the mailbox to attach", async () => (fleet.syncs > 0 ? true : null));

    // The mailbox itself goes bad. This must behave exactly as it always has — otherwise the
    // classifier exemption has quietly disabled quarantine for everything.
    fleet.behave(mailboxId, { failSync: true });

    const status = await until("the mailbox to be quarantined", async () => {
      const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
      return mb!.status === "error" ? mb!.status : null;
    });
    expect(status).toBe("error");
  }, 40_000);
});
