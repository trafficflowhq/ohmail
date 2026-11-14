import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messageInstances, messages, screenerAttemptKey,
  type RefundObligation, type RefundObligationPort, type Tx,
} from "@trafficflow/db";
import { createLogger, makeHaikuClassifier, type AnthropicLike, type ClassifierPort } from "@trafficflow/core";
import { fakeSpendPort, type FakeSpendPort } from "./_spendport.js";

/**
 * ONE OPTED-IN ACCOUNT ON PGLITE for the automatic pass's door suites: held senders, a recording
 * gate and debt store writing into one event list, and the REAL logger read back from its sink,
 * so a field the log census drops shows in the line.
 */

const SCREENER = "ohmail/Screener";
const OPTED_IN_AT = new Date("2026-08-01T00:00:00Z");
const ARRIVED = new Date("2026-08-02T00:00:00Z");
export const NOW = new Date("2026-08-03T00:00:00Z");

export interface World { db: Tx; accountId: string; mailboxId: string }

export async function world(): Promise<World> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "refund-door" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "door@example.test" }).returning();
  await db.insert(accountSettings).values({ accountId, autoSuggestAt: OPTED_IN_AT });
  return { db, accountId, mailboxId: mb!.id };
}

let nextUid = 1;

/** One held first-contact sender, `nth` seconds into the day, so the pass meets them in order. */
export async function held(w: World, from: string, nth: number): Promise<string> {
  const at = new Date(ARRIVED.getTime() + nth * 1000);
  const uid = nextUid++;
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `door:${randomUUID()}`,
    subject: `hello from ${from}`, fromAddress: from, snippet: "a first message",
    date: at, createdAt: at, nativeLocator: { folder: SCREENER, ref: `1:${uid}` },
  }).returning();
  await w.db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: SCREENER, observedFolder: SCREENER,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  // Its copy in the Screener, as the ingest records one.
  await w.db.insert(messageInstances).values({
    accountId: w.accountId, mailboxId: w.mailboxId, messageId: m!.id, folder: SCREENER, uidvalidity: 1n, uid, isPrimary: true,
  });
  return m!.id;
}

/** The real classifier over Anthropic's documented refusal (HTTP 200, no content) for `decline`. */
export function declining(decline: ReadonlySet<string>): ClassifierPort {
  const client = { messages: { create: async (params: unknown) => {
    const from = (JSON.parse((params as { messages: { content: string }[] }).messages[0]!.content) as { from: string }).from;
    return decline.has(from)
      ? { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" },
          usage: { input_tokens: 900, output_tokens: 0 } }
      : { content: [{ type: "text", text: JSON.stringify({ destination: "ohmail/News", confidence: 0.8, rationale: "a newsletter" }) }],
          stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 40 } };
  } } } as AnthropicLike;
  return makeHaikuClassifier({ client });
}

/** The gate, its releases written into the shared event list in call order. */
export function gateInto(events: string[]): FakeSpendPort {
  const gate = fakeSpendPort();
  gate.exclusive();
  const release = gate.release.bind(gate);
  gate.release = async (accountId, r) => {
    events.push(r.refund ? "refund" : "release");
    return release(accountId, r);
  };
  return gate;
}

/** The debt store, into the same event list; `owe` or `settle` throws as a failed database would. */
export function obligationsInto(events: string[], fails?: "owe" | "settle"): RefundObligationPort & {
  owed: RefundObligation[]; settled: string[];
} {
  const owed: RefundObligation[] = [];
  const settled: string[] = [];
  return {
    owed, settled,
    async owe(o) {
      events.push("owe");
      if (fails === "owe") throw new Error("08006 connection failure");
      owed.push(o);
    },
    async settle(_accountId, attempt) {
      events.push("settle");
      if (fails === "settle") throw new Error("57014 statement timeout");
      settled.push(attempt);
    },
  };
}

/** The REAL logger, its lines parsed back from the sink. */
export function recording() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ service: "worker", level: "debug", sink: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); } });
  return { logger, lines, named: (event: string) => lines.filter((l) => l.event === event) };
}

/** The attempt the gate said it charged for this message. */
export function attemptFor(gate: FakeSpendPort, messageId: string): string {
  const o = gate.spends.find((s) => s.attemptKey === screenerAttemptKey(messageId))!.outcome;
  return o.verdict === "ok" ? o.attempt : "";
}
