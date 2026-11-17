import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { contacts, mailboxes, messages, routingDecisions, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeHaikuClassifier, type AnthropicLike } from "@trafficflow/core";
import { makeClassifierCircuit } from "../src/ai-circuit.js";
import { runSyncCycle } from "@ohmail/organizer/sync";
import { FakeAdapterFleet } from "../../../packages/organizer/test/_fakeadapter.js";
import { FIXTURE_LEASE } from "../../../packages/organizer/test/_door.js";

/**
 * A DECLINED MESSAGE DOES NOT HOLD UP ITS MAILBOX — the production chain, end to end: a client
 * answering Anthropic's documented refusal, the real classifier, the worker's circuit, the pipeline
 * and one sync cycle. Before, the circuit wrapped the refusal as a provider fault, the cycle stopped
 * at that message, and the retry drew the same refusal, so later mail, read state and every folder
 * cursor waited behind it. Mutations: restore `throw err` for every classifier throw in
 * `pipeline.ts`, or delete the circuit's `ModelDeclinedError` arm.
 */

const ACCOUNT = "00000000-0000-4000-8000-00000000dec1";
const SENDERS = ["a@known.test", "b@known.test", "c@known.test"];

/** The refusals page, read 2026-10-12: HTTP 200, no content, the stop reason says why. */
const REFUSAL = {
  id: "msg_refusal", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [],
  stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
  usage: { input_tokens: 900, output_tokens: 0 },
};
const ANSWER = {
  id: "msg_ok", type: "message", role: "assistant", model: "claude-haiku-5-5",
  content: [{ type: "text", text: JSON.stringify({ destination: "ohmail/News", confidence: 0.9, rationale: "bulk", spam: false }) }],
  stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 40 },
};

/** The message titled `poison` draws `onPoison`; every other message is answered. */
function client(onPoison: () => unknown): AnthropicLike {
  return { messages: { create: async (params: unknown) => {
    const body = (params as { messages: { content: string }[] }).messages[0]!.content;
    return (JSON.parse(body) as { subject: string }).subject === "poison" ? onPoison() : ANSWER;
  } } } as AnthropicLike;
}

/** Three new messages from known senders (the AI branch's residue), the refused one first. */
async function cycle(anthropic: AnthropicLike) {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId: ACCOUNT, provider: "imap", address: `mb-${randomUUID().slice(0, 8)}@lichtgrat.example` })
    .returning();
  await db.insert(contacts).values(SENDERS.map((address) => ({ accountId: ACCOUNT, address })));
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  fleet.behave(mb!.id, {
    deliver: [
      { from: SENDERS[0]!, subject: "poison", messageId: "m-0@x" },
      { from: SENDERS[1]!, subject: "weekly digest", messageId: "m-1@x" },
      { from: SENDERS[2]!, subject: "monthly digest", messageId: "m-2@x" },
    ],
  });
  const circuit = makeClassifierCircuit(makeHaikuClassifier({ client: anthropic }));
  const run = runSyncCycle({
    writeAuthority: FIXTURE_LEASE,
    repo: makeDrizzleRepo(db as never), adapter, accountId: ACCOUNT,
    mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP,
    role: "organizer", trustedAuthservIds: new Set<string>(),
    classifier: circuit.port(mb!.id),
  });
  return { db, run, circuit };
}

describe("a declined message does not hold up its mailbox's sync", () => {
  it("the refused message is ingested as with AI off, and the messages after it are classified", async () => {
    const { db, run, circuit } = await cycle(client(() => REFUSAL));
    const out = await run;

    expect(out.hasBacklog).toBe(false);
    const rows = await db.select({ id: messages.id, subject: messages.subject }).from(messages);
    expect(rows.map((r) => r.subject).sort()).toEqual(["monthly digest", "poison", "weekly digest"]);
    const poison = rows.find((r) => r.subject === "poison")!.id;
    const decided = await db.select({ messageId: routingDecisions.messageId }).from(routingDecisions);
    expect(decided, "the two answered messages carry the model's decision").toHaveLength(2);
    expect(decided.map((d) => d.messageId)).not.toContain(poison);
    expect(circuit.state()).toMatchObject({ consecutiveFaults: 0, opens: 0 });
  });

  it("CONTROL: a provider fault on the same message still stops the cycle there, for the retry", async () => {
    const { db, run } = await cycle(client(() => { throw new Error("anthropic 529 overloaded"); }));

    await expect(run).rejects.toThrow();
    const rows = await db.select({ subject: messages.subject }).from(messages);
    expect(rows.map((r) => r.subject)).not.toContain("poison");
    expect(rows.length, "the cycle went past the faulted message").toBeLessThan(3);
  });
});
