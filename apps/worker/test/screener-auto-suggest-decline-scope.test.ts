import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messageInstances, messages, screenerAttemptKey,
  type RefundObligation, type RefundObligationPort, type Tx,
} from "@trafficflow/db";
import { makeHaikuClassifier, type AnthropicLike, type ClassifierInput, type ClassifierPort } from "@trafficflow/core";
import { fakeSpendPort } from "./_spendport.js";
import { makeClassifierCircuit } from "../src/ai-circuit.js";
import { makeDeclineMemory, screenerAutoSuggestPass } from "../src/screener-auto-suggest.js";

/**
 * AN AUTO-SUGGEST DECLINE RETURNS ITS OWN CHARGE AND NOBODY ELSE'S. Composed as the worker composes
 * it: the pass takes the circuit's bare `port()`, while two mailboxes hold open INGEST charges on
 * the circuit's meter. The decline is refunded at the pass's own door; both ingest charges stay
 * owed to their own outcome, which a later trip settles. Mutation: scope an absent mailbox to
 * "every" in `refundOwnCharge` (`ai-circuit.ts`) — the ingest charges come back on the decline.
 */

const SCREENER = "ohmail/Screener";
const OPTED_IN_AT = new Date("2026-08-01T00:00:00Z");
const ARRIVED = new Date("2026-08-02T00:00:00Z");
const NOW = new Date("2026-08-03T00:00:00Z");
const INGEST_INPUT: ClassifierInput = {
  from: { address: "news@example.test", name: "News" }, subject: "Digest", snippet: "stories", headersDigest: "",
};

/** The real classifier over Anthropic's documented refusal (HTTP 200, no content) for `decline`. */
function screeningModel(decline: ReadonlySet<string>): ClassifierPort & { asked: string[] } {
  const asked: string[] = [];
  const client = { messages: { create: async (params: unknown) => {
    const from = (JSON.parse((params as { messages: { content: string }[] }).messages[0]!.content) as { from: string }).from;
    asked.push(from);
    return decline.has(from)
      ? { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
          usage: { input_tokens: 900, output_tokens: 0 } }
      : { content: [{ type: "text", text: JSON.stringify({ destination: "ohmail/News", confidence: 0.8, rationale: "a newsletter" }) }],
          stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 40 } };
  } } } as AnthropicLike;
  return Object.assign(makeHaikuClassifier({ client }), { asked });
}

/** The provider as one switch: the model while up, an outage once `down` is set. */
function provider(model: ClassifierPort): ClassifierPort & { down: boolean } {
  const outage = (): Promise<never> => Promise.reject(new Error("anthropic 529 overloaded"));
  const p = {
    down: false,
    classify: (i: ClassifierInput, c?: Parameters<ClassifierPort["classify"]>[1]) => (p.down ? outage() : model.classify(i, c)),
    screen: (i: ClassifierInput, c?: Parameters<ClassifierPort["classify"]>[1]) => (p.down ? outage() : model.screen!(i, c)),
  };
  return p;
}

let nextUid = 1;

async function heldSender(db: Tx, accountId: string, mailboxId: string, from: string): Promise<string> {
  const uid = nextUid++;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, bodyHash: "h", dedupKey: `scope:${randomUUID()}`,
    subject: `hello from ${from}`, fromAddress: from, snippet: "a first message",
    date: ARRIVED, createdAt: ARRIVED, nativeLocator: { folder: SCREENER, ref: `1:${uid}` },
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  // Its copy in the Screener, as the ingest records one.
  await db.insert(messageInstances).values({
    accountId, mailboxId, messageId: m!.id, folder: SCREENER, uidvalidity: 1n, uid, isPrimary: true,
  });
  return m!.id;
}

function obligationsRecorder(): RefundObligationPort & { owed: RefundObligation[] } {
  const owed: RefundObligation[] = [];
  return { owed, async owe(o) { owed.push(o); }, async settle() { /* the receipt is the gate's */ } };
}

describe("an auto-suggest decline through the worker's circuit", () => {
  it("refunds the pass's own charge once and leaves every mailbox's open ingest charge owed", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "scope" });
    const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "scope@example.test" }).returning();
    await db.insert(accountSettings).values({ accountId, autoSuggestAt: OPTED_IN_AT });
    const declined = await heldSender(db, accountId, mb!.id, "a@example.test");

    // Open ingest charges on the circuit's meter: the candidate's own mailbox, and another one.
    const model = screeningModel(new Set(["a@example.test"]));
    const upstream = provider(model);
    const circuit = makeClassifierCircuit(upstream, { faultThreshold: 2 });
    const ingest = fakeSpendPort();
    ingest.exclusive();
    await circuit.meter(mb!.id, ingest).spend(accountId, "classify_ingest", `${mb!.id}:m1`);
    await circuit.meter("mbx-other", ingest).spend(accountId, "classify_ingest", "mbx-other:m1");

    const gate = fakeSpendPort();
    gate.exclusive();
    const obligations = obligationsRecorder();
    const r = await screenerAutoSuggestPass(db, {
      accountId, classifier: circuit.port(), credits: gate, obligations,
      declines: makeDeclineMemory(), now: () => NOW,
    });

    expect(model.asked).toEqual(["a@example.test"]);
    expect(r).toMatchObject({ ran: true, bought: 0, chargedAttempts: 0 });
    expect(r.stopped).toBeUndefined();
    // The pass's own charge, at its own door, with the obligation written for it.
    expect(gate.releases.filter((x) => x.refund)).toEqual([
      expect.objectContaining({ action: "screener", attemptKey: screenerAttemptKey(declined) }),
    ]);
    expect(obligations.owed).toEqual([expect.objectContaining({ action: "screener", reason: "drafter_failed" })]);
    // Neither ingest charge was the decline's to return.
    expect(ingest.releases, "the pass's decline refunded an ingest charge").toEqual([]);
    expect(circuit.state()).toMatchObject({ open: false, consecutiveFaults: 0 });

    // Both are still owed to their own outcome: the outage trips the circuit and refunds each once.
    upstream.down = true;
    for (let i = 0; i < 2; i++) await circuit.port(mb!.id)!.classify(INGEST_INPUT).catch(() => undefined);
    expect(circuit.state().open).toBe(true);
    expect(ingest.releases.map((x) => [x.attemptKey, x.refund]).sort()).toEqual([
      [`${mb!.id}:m1`, true], ["mbx-other:m1", true],
    ].sort());
  });
});
