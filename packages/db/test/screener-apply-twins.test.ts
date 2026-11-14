import { accountOfMessage } from "../src/parent-account.js";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { compareRules, effectForDestination, ruleMatchKey } from "@trafficflow/core/rule-order";
import { makeTestDb } from "../src/testing.js";
import { carryDialect } from "../src/dialect/index.js";
import { changeLog, folderState, mailboxes, messages, rules } from "../src/schema.js";
import { applyScreenerDecision, SCREENER_FOLDER } from "../src/screener-apply.js";

/**
 * A SCREENER DECISION BESIDE AN OUTRANKING TWIN (SCREENER-DECIDE-PROMOTES-BESIDE-AN-OUTRANKING-TWIN).
 * A deny rule written while the sender's mail waited at the gate outranked the allow the decide
 * promoted, so the held mail was filed into the Ohbox and the sender's next message screened. The
 * decision now converges the sender's key onto its acting row (SCREENER-DECIDE-ADDS-A-TWIN), so
 * that row takes the decision. Each case asks the router's order which rule files the sender's
 * NEXT message afterwards.
 */
const ACCT = "00000000-0000-0000-0000-0000000000eb";
const NOW = new Date("2026-09-25T09:00:00.000Z");
const ADDR = "lena@atelier.example";

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function held(db: Db, from = ADDR, organizerRole: "organizer" | "reader" = "organizer"): Promise<string> {
  const [mb] = await db.insert(mailboxes).values({
    accountId: ACCT, provider: "imap", address: `${crypto.randomUUID()}@x.test`, organizerRole,
  }).returning({ id: mailboxes.id });
  const [msg] = await db.insert(messages).values({
    accountId: ACCT, mailboxId: mb!.id, bodyHash: "h", dedupKey: crypto.randomUUID(),
    subject: "s", fromAddress: from, unread: true,
  }).returning({ id: messages.id });
  await db.insert(folderState).values({
    messageId: msg!.id, accountId: accountOfMessage(msg!.id), desiredFolder: SCREENER_FOLDER, observedFolder: SCREENER_FOLDER,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return msg!.id;
}

async function rule(db: Db, over: Partial<typeof rules.$inferInsert>): Promise<string> {
  const [r] = await db.insert(rules).values({
    accountId: ACCT, kind: "sender", match: ADDR, destination: "ohmail/Screened", provenance: "manual",
    ...over,
  }).returning({ id: rules.id });
  return r!.id;
}

async function decide(db: Db, messageId: string, dest: string, over: Record<string, unknown> = {}) {
  return db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
    accountId: ACCT, scope: "sender", address: ADDR, appliedFolder: dest,
    decision: effectForDestination(dest) === "allow" ? "yes" : "no",
    triggeringActionId: `screener:${messageId}`, now: NOW, decidedBy: "person", overExisting: "converge", ...over,
  }));
}

/** The destination the router files the sender's next message by: the minimum under its order. */
async function nextFiles(db: Db, kind = "sender", match = ADDR): Promise<string | null> {
  const rows = (await db.select().from(rules).where(eq(rules.accountId, ACCT)))
    .filter((r) => r.enabled && r.kind === kind && ruleMatchKey(r.match) === match && r.destination !== SCREENER_FOLDER);
  let winner: (typeof rows)[number] | null = null;
  const ordered = (r: (typeof rows)[number]) => ({ ...r, effect: effectForDestination(r.destination) });
  for (const r of rows) if (winner === null || compareRules(ordered(r), ordered(winner)) < 0) winner = r;
  return winner?.destination ?? null;
}

const destinationOf = async (db: Db, id: string) =>
  (await db.select().from(rules).where(eq(rules.id, id)))[0]!;

describe("a decide beside a deny twin written while the mail waited", () => {
  it("admitting the sender retargets the deny, so their next message files where they were admitted", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    const deny = await rule(db, {});
    expect(await nextFiles(db)).toBe("ohmail/Screened");

    await decide(db, m, "INBOX");

    expect((await destinationOf(db, deny)).destination).toBe("INBOX");
    expect(await nextFiles(db), "a screen-out still decides after the sender was admitted").toBe("INBOX");
  });

  it("the retarget is on the change log, so every client learns the deny moved", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    const deny = await rule(db, {});
    await decide(db, m, "INBOX");
    const logged = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule"), eq(changeLog.entityId, deny)));
    expect(logged.map((c) => c.op)).toEqual(["update"]);
  });

  it("with nothing re-routed here, the answer's seq is the retarget's, the last change it wrote", async () => {
    const db = await makeTestDb();
    const m = await held(db, ADDR, "reader");
    const deny = await rule(db, {});
    const result = await decide(db, m, "INBOX");
    expect(result.rerouted).toEqual([]);
    const [logged] = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityId, deny)));
    expect(result.lastSeq).toBe(logged!.seq);
  });

  it("the past-mail answer reaches the retargeted twin: armed when asked, left alone when declined", async () => {
    const asked = await makeTestDb();
    const a = await rule(asked, {});
    await decide(asked, await held(asked), "INBOX", { applyRetro: true });
    const armed = await destinationOf(asked, a);
    expect(armed.retroRequestedAt).toEqual(NOW);
    expect(armed.retroDoneAt).toBeNull();

    const declined = await makeTestDb();
    const d = await rule(declined, {});
    await decide(declined, await held(declined), "INBOX", { applyRetro: false });
    const left = await destinationOf(declined, d);
    expect(left.destination).toBe("INBOX");
    expect(left.retroRequestedAt).toBeNull();
  });

  it("a higher-priority allow elsewhere is a twin too: screening the sender out retargets it", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    const allow = await rule(db, { destination: "ohmail/News", priority: 5 });
    await decide(db, m, "ohmail/Screened");
    expect((await destinationOf(db, allow)).destination).toBe("ohmail/Screened");
    expect(await nextFiles(db)).toBe("ohmail/Screened");
  });

  it("the domain scope retargets the domain's twins and no address rule", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    const wide = await rule(db, { kind: "domain", match: "atelier.example" });
    const own = await rule(db, { kind: "sender", match: "someone@atelier.example" });
    await decide(db, m, "INBOX", { scope: "domain" });
    expect((await destinationOf(db, wide)).destination).toBe("INBOX");
    expect((await destinationOf(db, own)).destination, "a domain decide rewrote an address rule").toBe("ohmail/Screened");
    expect(await nextFiles(db, "domain", "atelier.example")).toBe("INBOX");
  });

  it("a deny twin saved with spaces around the address is retargeted too", async () => {
    // The router names the sender by `ruleMatchKey`, so a padded deny outranks the promoted allow
    // unless the retarget keys the twin the same way. RED at the base: the next message screened.
    const db = await makeTestDb();
    const m = await held(db);
    const deny = await rule(db, { match: ` ${ADDR} ` });
    expect(await nextFiles(db)).toBe("ohmail/Screened");
    await decide(db, m, "INBOX");
    expect((await destinationOf(db, deny)).destination).toBe("INBOX");
    expect(await nextFiles(db), "Allow did not take over a padded deny").toBe("INBOX");
  });
});

describe("what is NOT a twin keeps what it says", () => {
  it("another sender's rule, a term rule and a header rule are untouched; a paused row under the key takes the decision", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    const other = await rule(db, { match: "other@atelier.example" });
    const term = await rule(db, { subjectContains: "invoice" });
    const body = await rule(db, { bodyContains: "invoice" });
    const off = await rule(db, { enabled: false });
    const header = await rule(db, { kind: "header", match: ADDR });
    const result = await decide(db, m, "INBOX");
    for (const id of [other, term, body, header]) {
      expect((await destinationOf(db, id)).destination, id).toBe("ohmail/Screened");
    }
    // The paused row IS the sender's key: one rule per key, so it is the row the decision writes.
    expect(result.createdRuleId).toBe(off);
    expect(await destinationOf(db, off)).toMatchObject({ destination: "INBOX", enabled: true });
  });

  it("the ordinary decide is unchanged: no rule stands, one promoted rule is written and nothing else moves", async () => {
    const db = await makeTestDb();
    const m = await held(db);
    const result = await decide(db, m, "INBOX");
    const all = await db.select().from(rules).where(eq(rules.accountId, ACCT));
    expect(all.map((r) => [r.id, r.destination, r.provenance])).toEqual([[result.createdRuleId, "INBOX", "promoted"]]);
    const logged = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, ACCT), eq(changeLog.entityType, "rule")));
    expect(logged.map((c) => c.op)).toEqual(["create"]);
  });

  for (const enabled of [true, false]) {
    it(`a caller that skips a ruled key writes and files nothing over ${enabled ? "an enabled" : "a paused"} rule`, async () => {
      const db = await makeTestDb();
      const m = await held(db);
      const deny = await rule(db, { enabled });
      const result = await decide(db, m, "INBOX", { overExisting: "skip" });
      expect(result).toMatchObject({ skipped: "ruled", createdRuleId: null, rerouted: [], lastSeq: null });
      expect((await db.select().from(rules).where(eq(rules.accountId, ACCT))).map((r) => [r.id, r.destination, r.enabled]))
        .toEqual([[deny, "ohmail/Screened", enabled]]);
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, m));
      expect(fs!.desiredFolder, "the held message was filed over a sender who has a rule").toBe(SCREENER_FOLDER);
    });
  }
});
