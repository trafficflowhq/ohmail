import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messageInstances, messages, sourceFor, type RefundObligationPort, type Tx,
} from "@trafficflow/db";
import {
  makeEntitlementsClient, pendingRefundObligations, refundObligationsOn, type EntitlementsFetch,
} from "@trafficflow/db/cloud";
import { createLogger, makeHaikuClassifier, type AnthropicLike } from "@trafficflow/core";
import { makeClassifierCircuit } from "../src/ai-circuit.js";
import { makeDeclineMemory, screenerAutoSuggestPass } from "../src/screener-auto-suggest.js";
import { refundObligationDrainPass } from "../src/refund-obligation-drain.js";

/**
 * A SETTLE THAT THROWS AFTER A SETTLED REFUND LEAVES THE DEBT OPEN, AND THE DRAIN SENDS IT AGAIN.
 * The guard is the program's one-refund-per-attempt rule: its ledger source `refund:<attempt>` is
 * unique, so a repeat answers 200 and moves nothing (the billing plane's `refundCredits`). This is
 * the CLIENT's half, through the real entitlements client: the drain's re-send names the account,
 * action, bare key and attempt of the door's refund. Mutation: the drain re-sends another attempt.
 */

const SCREENER = "ohmail/Screener";
const NOW = new Date("2026-08-03T00:00:00Z");
const COST = 3;

/**
 * THE PROGRAM, as its port contract states the two calls: a spend charges a source once and names
 * the attempt; a refund release reverses `attempt ?? source` once, refuses a refund of nothing
 * (503), and answers a repeat 200 while moving nothing. It keeps a balance, so "moved once" is a
 * measured amount and not a count of calls.
 */
function program() {
  let balance = 100;
  /** attempt → whether it was reversed. Attempt 1 of a source is the source itself. */
  const charged = new Map<string, boolean>();
  const releases: Array<Record<string, unknown>> = [];
  const fetchImpl: EntitlementsFetch = async (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const reply = (status: number, json: unknown) => ({ status, json: async () => json });
    const source = sourceFor(body.action as "screener", String(body.attemptKey));
    const path = new URL(url).pathname;
    if (path === "/v1/spend") {
      if (charged.has(source)) return reply(200, { verdict: "duplicate", charged: false, attempt: source });
      charged.set(source, false);
      balance -= COST;
      return reply(200, { verdict: "ok", charged: true, attempt: source });
    }
    if (path === "/v1/spend/release") {
      releases.push(body);
      if (body.refund !== true) return reply(200, { released: true, refunded: false });
      const attempt = typeof body.attempt === "string" && body.attempt !== "" ? body.attempt : source;
      if (!charged.has(attempt)) return reply(503, { error: "db_unavailable" });
      if (charged.get(attempt) === false) {
        charged.set(attempt, true);
        balance += COST;
      }
      return reply(200, { released: true, refunded: true });
    }
    return reply(404, {});
  };
  return { fetchImpl, releases, balance: () => balance };
}

const clientOf = (fetchImpl: EntitlementsFetch) => makeEntitlementsClient({
  baseUrl: "https://program.test", secret: "fixture", fetchImpl, onCallFault: "unrecorded",
});

/** Anthropic's documented refusal for every sender: the declined charge is what gets refunded. */
const refusing = makeHaikuClassifier({ client: { messages: { create: async () => ({
  content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
  usage: { input_tokens: 900, output_tokens: 0 },
}) } } as AnthropicLike });

async function heldWorld(): Promise<{ db: Tx; accountId: string }> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "settle-contract" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "settle@example.test" }).returning();
  await db.insert(accountSettings).values({ accountId, autoSuggestAt: new Date("2026-08-01T00:00:00Z") });
  const at = new Date("2026-08-02T00:00:00Z");
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `settle:${randomUUID()}`,
    subject: "hello", fromAddress: "a@example.test", snippet: "a first message",
    date: at, createdAt: at, nativeLocator: { folder: SCREENER, ref: "1:1" },
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  // Its copy in the Screener, as the ingest records one.
  await db.insert(messageInstances).values({
    accountId, mailboxId: mb!.id, messageId: m!.id, folder: SCREENER, uidvalidity: 1n, uid: 1, isPrimary: true,
  });
  return { db, accountId };
}

describe("a settle that fails after a settled refund: the drain's re-send is the same refund", () => {
  it("the door's refund lands, its settle throws, and the drain re-sends that refund, which moves money once", async () => {
    const { db, accountId } = await heldWorld();
    const plane = program();
    const client = clientOf(plane.fetchImpl);
    const store = refundObligationsOn(db);
    const obligations: RefundObligationPort = {
      owe: (o) => store.owe(o),
      settle: async () => { throw new Error("57014 statement timeout"); },
    };
    const lines: Array<Record<string, unknown>> = [];
    const log = createLogger({ service: "worker", level: "debug", sink: (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); } });

    await screenerAutoSuggestPass(db, {
      accountId, classifier: makeClassifierCircuit(refusing).port(), credits: client, obligations, log,
      declines: makeDeclineMemory(), now: () => NOW,
    });

    expect(plane.balance(), "the declined charge was not returned").toBe(100);
    const open = await pendingRefundObligations(db, accountId);
    expect(open, "the debt was settled although its settle threw").toHaveLength(1);
    expect(lines.filter((l) => l.event === "screener_auto_suggest_refund_settle_failed"))
      .toEqual([expect.objectContaining({ accountId, attempt: open[0]!.attempt })]);

    const r = await refundObligationDrainPass(db, { credits: client, log });

    expect(r).toEqual({ claimed: 1, settled: 1, owed: 0 });
    expect(plane.balance(), "the drain's re-send returned the credit a second time").toBe(100);
    expect(await pendingRefundObligations(db, accountId)).toEqual([]);
    const refunds = plane.releases.filter((b) => b.refund === true);
    expect(refunds).toHaveLength(2);
    const identity = (b: Record<string, unknown>) =>
      ({ accountId: b.accountId, action: b.action, attemptKey: b.attemptKey, refund: b.refund, attempt: b.attempt });
    expect(identity(refunds[1]!), "the drain's re-send is not the door's refund").toEqual(identity(refunds[0]!));
    expect(refunds[0]!.attempt).toBe(open[0]!.attempt);
  });

  it("CONTROL: the double keys its rule on the attempt — a second charge's refund moves money again", async () => {
    const plane = program();
    const client = clientOf(plane.fetchImpl);
    const first = await client.spend("acct-1", "screener", "m1");
    const second = await client.spend("acct-1", "screener", "m2");
    const attempt = (o: typeof first): string => (o.verdict === "ok" ? o.attempt : "");
    expect(plane.balance()).toBe(100 - 2 * COST);

    expect(await client.release("acct-1", { action: "screener", attemptKey: "m1", refund: true, attempt: attempt(first) })).toBe("settled");
    expect(await client.release("acct-1", { action: "screener", attemptKey: "m1", refund: true, attempt: attempt(first) })).toBe("settled");
    expect(plane.balance(), "a repeat of one attempt's refund moved money").toBe(100 - COST);
    expect(await client.release("acct-1", { action: "screener", attemptKey: "m2", refund: true, attempt: attempt(second) })).toBe("settled");
    expect(plane.balance()).toBe(100);
    expect(await client.release("acct-1", { action: "screener", attemptKey: "m3", refund: true, attempt: "screener:never" }))
      .toBe("unreachable");
  });
});
