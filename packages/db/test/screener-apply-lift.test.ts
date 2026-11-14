import { accountOfMessage } from "../src/parent-account.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addressPriorityOver as coreLift } from "@trafficflow/core/rule-order";
import { makeTestDb } from "../src/testing.js";
import { carryDialect } from "../src/dialect/index.js";
import { mailboxes, messages, folderState, rules } from "../src/schema.js";
import { RULE_PRIORITY_MAX, SCREENER_FOLDER, addressPriorityOver, applyScreenerDecision } from "../src/screener-apply.js";

/**
 * A DECISION ABOUT AN ADDRESS OUTRANKS ITS DOMAIN'S RULE. The decide promoted its rule at priority
 * 0, so a sender waiting at the gate under a priority-5 domain rule filing elsewhere was decided
 * and still filed by the domain rule. The promoted rule is written at the domain rule's priority,
 * inside the decide's transaction, never past the one bound — and the auto-act pass never lifts.
 */
const ACCT = "00000000-0000-0000-0000-0000000000eb";
const NOW = new Date("2026-09-25T12:00:00.000Z");
const ADDR = "alerts@kestrel.example";

async function world(domainPriority: number, domainMatch = "kestrel.example") {
  const db = await makeTestDb();
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCT, provider: "imap", address: `${crypto.randomUUID()}@x.example` })
    .returning({ id: mailboxes.id });
  const [msg] = await db.insert(messages).values({
    accountId: ACCT, mailboxId: mb!.id, bodyHash: "h", dedupKey: crypto.randomUUID(), subject: "s", fromAddress: ADDR, unread: true,
  }).returning({ id: messages.id });
  await db.insert(folderState).values({
    messageId: msg!.id, accountId: accountOfMessage(msg!.id), desiredFolder: SCREENER_FOLDER, observedFolder: SCREENER_FOLDER,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  await db.insert(rules).values({
    accountId: ACCT, kind: "domain", match: domainMatch, destination: "ohmail/Screened",
    provenance: "manual", enabled: true, priority: domainPriority,
  });
  return db;
}

async function decide(db: Awaited<ReturnType<typeof makeTestDb>>, liftOverDomain?: boolean) {
  const out = await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
    accountId: ACCT, scope: "sender", address: ADDR, appliedFolder: "INBOX", decision: "yes",
    triggeringActionId: "screener:lift", now: NOW, decidedBy: "person", overExisting: "converge",
    ...(liftOverDomain === undefined ? {} : { liftOverDomain }),
  }));
  const [rule] = await db.select().from(rules).where(eq(rules.id, out.createdRuleId!));
  return rule!;
}

describe("the decide lifts the promoted address rule over its domain's", () => {
  it("a priority-5 domain rule filing elsewhere: the promoted rule is written at 5", async () => {
    expect((await decide(await world(5))).priority).toBe(5);
  });

  it("a domain rule saved with spaces around it is lifted over too", async () => {
    // The router reads ` kestrel.example ` as the domain's rule; RED at the base, written at 0.
    expect((await decide(await world(5, " kestrel.example "))).priority).toBe(5);
  });

  it("the auto-act door's false writes it at 0", async () => {
    expect((await decide(await world(5), false)).priority).toBe(0);
  });

  it("past the bound the lift declines", async () => {
    expect((await decide(await world(RULE_PRIORITY_MAX + 1))).priority).toBe(0);
    expect((await decide(await world(RULE_PRIORITY_MAX))).priority).toBe(RULE_PRIORITY_MAX);
  });

  it("the pinned lift answers as core's does", () => {
    const cases: Array<[Array<{ priority: number; destination: string }>, string, number]> = [
      [[{ priority: 5, destination: "ohmail/Screened" }], "INBOX", 0],
      [[{ priority: 7, destination: "INBOX" }], "INBOX", 0],
      [[{ priority: 5, destination: "ohmail/Screened" }], "INBOX", 9],
      [[{ priority: RULE_PRIORITY_MAX + 1, destination: "ohmail/Screened" }], "INBOX", 0],
      [[{ priority: Number.NaN, destination: "x" }, { priority: 3, destination: "y" }], "INBOX", 0],
    ];
    for (const [rows, dest, held] of cases) expect(addressPriorityOver(rows, dest, held)).toBe(coreLift(rows, dest, held));
  });

  it("the auto-act pass skips a ruled key and does not lift, at its one call site", () => {
    const src = readFileSync(resolve(import.meta.dirname ?? ".", "../../../apps/worker/src/screener-auto-act.ts"), "utf8");
    const call = src.slice(src.indexOf("applyScreenerDecision(tx, {"));
    const body = call.slice(0, call.indexOf("});"));
    expect(body.length, "the call site was not found").toBeGreaterThan(50);
    expect(body).toMatch(/overExisting: "skip"/);
    expect(body).toMatch(/liftOverDomain: false/);
  });
});
