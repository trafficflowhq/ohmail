import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accountSettings, auditLog, contacts, folderState, learningSignals, mailboxCredentials, mailboxes, messages,
  routingDecisions, rules, SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS,
} from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, type Logger } from "@trafficflow/core";
import { startWorker } from "../src/index.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { ORGANIZER_CONSENT } from "./_workerdb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * NO AUTOMATIC PASS LETS A STRANGER IN (owner report 2026-11-02): a cold letter from a sender the
 * person never chose reached News. Every header that made it look like a newsletter is the sender's
 * to write — the one-click unsubscribe pair a mailing service puts on cold outreach too. Through the
 * REAL worker: ingest holds both letters, and with every automatic switch on (the old bulk filing,
 * the act on suggestions with the AI on) and confident advice to let them in, cycle after cycle they
 * still wait at the Screener, and nothing standing is written for their senders.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 52));
let DB = "";
type Db = ReturnType<typeof makeDb>;

/** Every bulk header the sender can write, and the tracking image. */
const COLD_HEADERS = [
  "List-Unsubscribe: <https://hire-outreach.example/u/1>, <mailto:unsub@hire-outreach.example>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  "Feedback-ID: 1:campaign:hire-outreach",
];
const PIXEL = '<p>Hello,</p><p>a quick question.</p><img src="https://hire-outreach.example/o/1.gif" width="1" height="1">';
const COLD = [
  { from: "talent@hire-outreach.example", subject: "Quick question about your next role", messageId: "cold-1@hire-outreach.example", to: "ohmail/News" },
  { from: "billing@hire-outreach.example", subject: "Your invoice for the interview pack", messageId: "cold-2@hire-outreach.example", to: "ohmail/Receipts" },
] as const;

function eventLogger(events: string[]): Logger {
  const self: Logger = {
    level: "debug", child: () => self,
    debug: (e) => { events.push(e); }, info: (e) => { events.push(e); },
    warn: (e) => { events.push(e); }, error: (e) => { events.push(e); },
  };
  return self;
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

describe("no automatic pass lets a stranger into News or Receipts", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_nopass"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("two cold letters with bulk headers and advice to let them in wait at the Screener, cycle after cycle", async () => {
    const db: Db = makeDb(DB);
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, ...ORGANIZER_CONSENT }).returning();
    const enc = await KP.encrypt("pw");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });
    // Every automatic switch on: the old bulk filing, automatic suggestions and the act on them.
    const on = new Date(Date.now() - 60_000);
    await db.insert(accountSettings).values({
      accountId, screenerAutoApplyAt: on, autoSuggestAt: on, screenerAutoActAt: on, screeningScope: "all_time",
    });

    const fleet = new FakeAdapterFleet();
    fleet.behave(mb!.id, {
      deliver: COLD.map((c) => ({
        from: c.from, subject: c.subject, messageId: c.messageId, headers: [...COLD_HEADERS],
        contentType: "text/html; charset=utf-8", body: PIXEL,
      })),
    });
    const events: string[] = [];
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory, logger: eventLogger(events), maxSyncFailures: 3,
      organizer: { installId: "cloud-nopass", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());

    const held = async (): Promise<Array<{ id: string; from: string; desired: string }>> =>
      db.select({ id: messages.id, from: messages.fromAddress, desired: folderState.desiredFolder })
        .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
        .where(eq(messages.accountId, accountId));
    await waitFor(async () => (await held()).length === COLD.length, 20_000, "both letters ingested");
    expect((await held()).map((m) => m.desired), "premise: ingest holds both strangers").toEqual(["ohmail/Screener", "ohmail/Screener"]);

    // Confident advice to let each in, as the suggest pass stores it.
    for (const m of await held()) {
      const cold = COLD.find((c) => c.from === m.from)!;
      await db.insert(routingDecisions).values({
        accountId, messageId: m.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE, destination: cold.to,
        confidence: 0.99, rationale: "", spam: false, status: SCREENER_SUGGESTION_STATUS, senderReason: "none",
      });
    }
    const tails = events.filter((e) => e === "cycle_phases").length;
    await waitFor(() => events.filter((e) => e === "cycle_phases").length >= tails + 3, 30_000, "three more cycle tails");

    for (const m of await held()) expect(m.desired, `${m.from} was let in by a pass`).toBe("ohmail/Screener");
    expect(await db.select().from(rules).where(eq(rules.accountId, accountId))).toEqual([]);
    expect(await db.select().from(contacts).where(eq(contacts.accountId, accountId))).toEqual([]);
    // The reconciler's record of carrying out the hold on the server is the only audit row.
    const audits = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.accountId, accountId));
    expect(audits.map((a) => a.action).filter((a) => a !== "reconcile.move"), "a pass filed a cold letter").toEqual([]);
  }, 90_000);

  it("the cycle tail retires what the act let in before, once per account per process", async () => {
    const db: Db = makeDb(DB);
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, ...ORGANIZER_CONSENT }).returning();
    const enc = await KP.encrypt("pw");
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
    });
    /** What the 0.30.28 act wrote when it let `address` in: its rule, an inferred contact, its decision. */
    const actAdmitted = async (address: string) => {
      await db.insert(rules).values({
        accountId, kind: "sender", match: address, destination: "ohmail/News", provenance: "promoted", enabled: true, priority: 0,
      });
      await db.insert(contacts).values({ accountId, address, source: "inferred" });
      await db.insert(learningSignals).values({
        accountId, triggeringActionId: `screener:auto:${randomUUID()}`, kind: "screener", senderAddress: address,
        destination: "ohmail/News", label: "positive",
      });
    };
    await actAdmitted(COLD[0].from);

    const fleet = new FakeAdapterFleet();
    const events: string[] = [];
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
      adapterFactory: fleet.factory, logger: eventLogger(events), maxSyncFailures: 3,
      organizer: { installId: "cloud-retire", displayName: "Cloud", staleAfterMs: 60_000 },
    });
    closers.push(() => worker.stop());
    const ruleCount = async () => (await db.select({ id: rules.id }).from(rules).where(eq(rules.accountId, accountId))).length;
    await waitFor(async () => (await ruleCount()) === 0, 30_000, "the act's rule retired");
    expect(await db.select().from(contacts).where(eq(contacts.accountId, accountId))).toEqual([]);

    // A finished account is not walked again in this process: what appears later stays.
    await actAdmitted(COLD[1].from);
    const tails = events.filter((e) => e === "cycle_phases").length;
    await waitFor(() => events.filter((e) => e === "cycle_phases").length >= tails + 3, 30_000, "three more cycle tails");
    expect(await ruleCount()).toBe(1);
    const retired = await db.select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, "screener.act_admission_retired")));
    expect(retired).toHaveLength(1);
  }, 90_000);
});
