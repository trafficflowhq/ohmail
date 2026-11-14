import { accountOfMessage } from "../src/parent-account.js";
import { describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { effectForDestination, ruleMatchKey } from "@trafficflow/core/rule-order";
import { makeTestDb } from "../src/testing.js";
import { carryDialect } from "../src/dialect/index.js";
import { changeLog, folderState, mailboxes, messages, rules } from "../src/schema.js";
import { applyScreenerDecision, SCREENER_FOLDER } from "../src/screener-apply.js";

/**
 * SCREENER-DECIDE-ADDS-A-TWIN. A decision about a sender who already has a rule under the bare
 * sender key writes one rule per key: the ACTING row takes the decision (the place, on, the higher
 * priority, the person's stamp; manual and migrated provenance kept, anything else `promoted`) and
 * its twins go, nothing is inserted beside it. Each case reads the rows under the key afterwards.
 */
const ACCT = "00000000-0000-0000-0000-0000000000ec";
const NOW = new Date("2026-10-04T03:00:00.000Z");
const ADDR = "lena@atelier.example";

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function held(db: Db): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${crypto.randomUUID()}@x.test`, organizerRole: "organizer",
  }).returning({ id: mailboxes.id });
  const [msg] = await db.insert(messages).values({
    accountId: ACCT, mailboxId: mb!.id, bodyHash: "h", dedupKey: crypto.randomUUID(),
    subject: "s", fromAddress: ADDR, unread: true,
  }).returning({ id: messages.id });
  await db.insert(folderState).values({
    messageId: msg!.id, accountId: accountOfMessage(msg!.id), desiredFolder: SCREENER_FOLDER, observedFolder: SCREENER_FOLDER,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return msg!.id;
}

async function decide(db: Db, messageId: string, dest: string, over: Record<string, unknown> = {}) {
  return db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
    accountId: ACCT, scope: "sender", address: ADDR, appliedFolder: dest,
    decision: effectForDestination(dest) === "allow" ? "yes" : "no",
    triggeringActionId: `screener:${messageId}`, now: NOW, decidedBy: "person", overExisting: "converge", ...over,
  }));
}

/** Every row under the bare sender key: destination and provenance, sorted. */
async function underKey(db: Db) {
  return (await db.select().from(rules).where(eq(rules.accountId, ACCT)))
    .filter((r) => r.kind === "sender" && ruleMatchKey(r.match) === ADDR && r.subjectContains === null && r.bodyContains === null)
    .map((r) => `${r.destination}/${r.provenance}`).sort();
}

describe("a Screener decision about a sender who already has a rule", () => {
  it("yes into the Ohbox over a manual Ohbox rule leaves one rule under the key", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: ADDR, destination: "INBOX", provenance: "manual" });
    await decide(db, m, "INBOX");
    expect(await underKey(db)).toHaveLength(1);
  });

  it("no into Screened over a manual Ohbox rule leaves one rule under the key", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: ADDR, destination: "INBOX", provenance: "manual" });
    await decide(db, m, "ohmail/Screened");
    expect(await underKey(db)).toHaveLength(1);
  });

  it("a rule with a subject term is another rule: the decision adds the bare one beside it", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    await db.insert(rules).values({
      accountId: ACCT, kind: "sender", match: ADDR, destination: "ohmail/News", provenance: "manual", subjectContains: "invoice",
    });
    await decide(db, m, "INBOX");
    expect(await underKey(db)).toEqual(["INBOX/promoted"]);
    expect((await db.select().from(rules).where(eq(rules.accountId, ACCT))).length).toBe(2);
  });

  it("the acting row survives, its twins go first on the change log, and the answer names it", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    const [manual] = await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: ADDR, destination: "INBOX", provenance: "manual" }).returning();
    const [screened] = await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: ADDR, destination: "ohmail/Screened", provenance: "promoted" }).returning();
    const out = await decide(db, m, "ohmail/News");
    expect(out).toMatchObject({ createdRuleId: screened!.id, retargetedRuleIds: [] });
    const log = await db.select().from(changeLog).where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule"))).orderBy(asc(changeLog.seq));
    expect(log.map((c) => [c.op, c.entityId])).toEqual([["delete", manual!.id], ["update", screened!.id]]);
    expect(await underKey(db)).toEqual(["ohmail/News/promoted"]);
  });

  it("provenance: a manual row stays manual, a seeded row becomes promoted", async () => {
    const db = await makeTestDb();
    await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: ADDR, destination: "ohmail/Screened", provenance: "manual" });
    await decide(db, await held(db), "INBOX");
    expect(await underKey(db)).toEqual(["INBOX/manual"]);

    const db2 = await makeTestDb();
    await db2.insert(rules).values({ accountId: ACCT, kind: "sender", match: ADDR, destination: "INBOX", provenance: "seeded-from-sent" });
    await decide(db2, await held(db2), "ohmail/Screened");
    expect(await underKey(db2)).toEqual(["ohmail/Screened/promoted"]);
  });

  it("priority: the survivor keeps the higher of its own and the decision's lift over the domain", async () => {
    for (const [own, lifted, want] of [[7, 3, 7], [0, 3, 3]] as const) {
      const db = await makeTestDb();
      await db.insert(rules).values({ accountId: ACCT, kind: "domain", match: "atelier.example", destination: "ohmail/Screened", provenance: "manual", priority: lifted });
      await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: ADDR, destination: "ohmail/News", provenance: "manual", priority: own });
      await decide(db, await held(db), "INBOX");
      const [row] = (await db.select().from(rules).where(and(eq(rules.accountId, ACCT), eq(rules.kind, "sender"))));
      expect(row!.priority, `own ${own}, lift ${lifted}`).toBe(want);
    }
  });

  it("a paused row under the key is switched on and its backlog asked for", async () => {
    const db = await makeTestDb();
    await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: ADDR, destination: "INBOX", provenance: "manual", enabled: false });
    await decide(db, await held(db), "INBOX");
    const [row] = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect({ enabled: row!.enabled, retro: row!.retroRequestedAt }).toEqual({ enabled: true, retro: NOW });
  });

  it("a person's decision stamps the person's licence on the survivor; a pass's fresh row carries none", async () => {
    const db = await makeTestDb();
    await db.insert(rules).values({ accountId: ACCT, kind: "sender", match: ADDR, destination: "INBOX", provenance: "manual" });
    await decide(db, await held(db), "ohmail/Screened");
    expect((await db.select().from(rules).where(eq(rules.accountId, ACCT)))[0]!.personDecidedAt).toEqual(NOW);

    const db2 = await makeTestDb();
    await decide(db2, await held(db2), "ohmail/Screened", { decidedBy: "pass", overExisting: "skip" });
    expect((await db2.select().from(rules).where(eq(rules.accountId, ACCT)))[0]!.personDecidedAt).toBeNull();
  });

  it("a decision the row already holds writes no rule delta", async () => {
    const db = await makeTestDb();
    await db.insert(rules).values({
      accountId: ACCT, kind: "sender", match: ADDR, destination: "INBOX", provenance: "manual", personDecidedAt: NOW,
    });
    await decide(db, await held(db), "INBOX");
    const log = await db.select().from(changeLog).where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule")));
    expect(log).toEqual([]);
  });
});
