import { accountOfMessage } from "../src/parent-account.js";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../src/testing.js";
import { carryDialect } from "../src/dialect/index.js";
import { folderState, mailboxes, messages } from "../src/schema.js";
import { applyScreenerDecision, SCREENER_FOLDER } from "../src/screener-apply.js";

/**
 * A PERSON'S PRESS MOVES A CLAIM ONLY FROM THE ADDRESS IT WAS MADE ON (mail 0148).
 * A domain-scope yes on one sender's row moves that sender's held mail, the marked row included —
 * the row told them — and every other address's mail but its claims: another address's marked row
 * at that domain waits for a press on its own row and its own sentence. Another address's row the
 * check never reached is checked first through the caller's checker, or stays without one.
 */
const ACCT = "00000000-0000-0000-0000-0000000000eb";
const NOW = new Date("2026-10-07T12:00:00.000Z");

async function world() {
  const db = await makeTestDb();
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCT, provider: "imap", address: "me@own.test" })
    .returning({ id: mailboxes.id });
  const held = async (fromAddress: string, senderCheck: "none" | "impersonation" | null) => {
    const [m] = await db.insert(messages).values({
      accountId: ACCT, mailboxId: mb!.id, bodyHash: "h", dedupKey: crypto.randomUUID(), subject: "s", fromAddress,
      senderCheck, senderCheckBrand: senderCheck === "impersonation" ? "PostFinance" : null,
    }).returning({ id: messages.id });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: accountOfMessage(m!.id), desiredFolder: SCREENER_FOLDER, observedFolder: SCREENER_FOLDER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const check = async (id: string) =>
    (await db.select({ c: messages.senderCheck }).from(messages).where(eq(messages.id, id)))[0]!.c;
  type Checker = NonNullable<Parameters<typeof applyScreenerDecision>[1]["checkUnchecked"]>;
  const press = (scope: "sender" | "domain", address: string, checkUnchecked?: Checker) => db.transaction((tx) =>
    applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCT, scope, address, appliedFolder: "INBOX", decision: "yes", triggeringActionId: `t-${address}`,
      now: NOW, overExisting: "converge", decidedBy: "person", ...(checkUnchecked ? { checkUnchecked } : {}),
    }));
  return { held, desired, check, press };
}

describe("a person's domain press and the claims of other addresses", () => {
  it("moves the pressed address's claim and every other address's mail, and leaves another address's claim", async () => {
    const w = await world();
    const pressedClaim = await w.held("anna@firma.test", "impersonation");
    const otherClaim = await w.held("bob@firma.test", "impersonation");
    const otherClean = await w.held("carl@firma.test", "none");
    await w.press("domain", "anna@firma.test");
    expect(await w.desired(pressedClaim)).toBe("INBOX");
    expect(await w.desired(otherClean)).toBe("INBOX");
    expect(await w.desired(otherClaim)).toBe(SCREENER_FOLDER);
  });

  it("checks another address's unchecked rows first: a clean one moves, a claim stays", async () => {
    const w = await world();
    const pressedUnchecked = await w.held("anna@firma.test", null);
    const clean = await w.held("dora@firma.test", null);
    const claim = await w.held("eve@firma.test", null);
    const asked: string[] = [];
    // The services pass core's `checkUncheckedById`; this stand-in writes the verdict it is told.
    await w.press("domain", "anna@firma.test", async (tx, _account, ids) => {
      asked.push(...ids);
      for (const id of ids) {
        await tx.update(messages).set(id === claim ? { senderCheck: "impersonation", senderCheckBrand: "PostFinance" } : { senderCheck: "none" })
          .where(eq(messages.id, id));
      }
    });
    expect(asked.sort()).toEqual([pressedUnchecked, clean, claim].sort());
    expect(await w.desired(pressedUnchecked)).toBe("INBOX");
    expect(await w.desired(clean)).toBe("INBOX");
    expect(await w.desired(claim)).toBe(SCREENER_FOLDER);
    expect(await w.check(claim)).toBe("impersonation");
  });

  it("without a checker another address's unchecked row stays at the gate, and the pressed address's moves", async () => {
    const w = await world();
    const mine = await w.held("anna@firma.test", null);
    const other = await w.held("dora@firma.test", null);
    await w.press("domain", "anna@firma.test");
    expect(await w.desired(mine)).toBe("INBOX");
    expect(await w.desired(other)).toBe(SCREENER_FOLDER);
  });

  it("CONTROL: a press on that address's own row moves its claim", async () => {
    const w = await world();
    const claim = await w.held("bob@firma.test", "impersonation");
    await w.press("domain", "anna@firma.test");
    expect(await w.desired(claim)).toBe(SCREENER_FOLDER);
    await w.press("sender", "bob@firma.test");
    expect(await w.desired(claim)).toBe("INBOX");
  });
});
