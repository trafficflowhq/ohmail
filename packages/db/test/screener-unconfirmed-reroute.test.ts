import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { carryDialect } from "../src/dialect/index.js";
import type { Tx } from "../src/change-log.js";
import { AccountErasedError } from "../src/erasure-fence.js";
import { accounts, auditLog, changeLog, contacts, folderState, learningSignals, mailboxes, messages, rules } from "../src/schema.js";
import { applyScreenerDecision, rerouteAdvisedLetter, rerouteUnconfirmedHeld, SCREENER_FOLDER } from "../src/screener-apply.js";

/**
 * A PASS'S DENY ON A LETTER ITS PROVIDER DID NOT CONFIRM, on this store: the filing moves only the
 * sender's held letters whose `auth_verdict` is not `pass` (NULL included), narrowed to one letter
 * when asked, and never one the person put back, and writes nothing standing — no rule, no contact,
 * no learning signal. Each letter it files is recorded as an automatic filing with its undo, the
 * record Filed automatically lists and Put back reads. It cannot admit: an admitting destination, or
 * the gate itself, is refused before any statement. A sender whose key has a rule is not its to
 * file. CONTROL: a person's deny on the same sender still writes their rule and moves every held letter.
 */
const SPAM = "ohmail/Quarantine";
const NOW = new Date("2026-10-19T08:00:00.000Z");
const SENDER = "service@paypal.com";

async function world() {
  const db = await makeTestDb();
  const newAccount = async (): Promise<{ accountId: string; mailboxId: string }> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `unc-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `unc-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  };
  const own = await newAccount();
  /** One held letter of `from`, checked clean, its provider's verdict as given. */
  const letter = async (from: string, authVerdict: string | null, at = own): Promise<string> => {
    const [m] = await db.insert(messages).values({
      accountId: at.accountId, mailboxId: at.mailboxId, bodyHash: "h", dedupKey: `unc:${randomUUID()}`,
      subject: "Your receipt", fromAddress: from, authVerdict, senderCheck: "none",
      nativeLocator: { folder: SCREENER_FOLDER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER_FOLDER, observedFolder: SCREENER_FOLDER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  // The store's brand rides the transaction, as the worker's fence carries it.
  const inTx = <T>(f: (tx: Tx) => Promise<T>): Promise<T> =>
    (db as unknown as Tx).transaction((tx) => f(carryDialect(db, tx as object) as unknown as Tx)) as Promise<T>;
  const file = (appliedFolder = SPAM, address = SENDER, only?: string) => inTx((tx) => rerouteUnconfirmedHeld(tx, {
    accountId: own.accountId, address, appliedFolder, now: NOW, ...(only === undefined ? {} : { only }),
  }));
  const desiredOf = async (id: string): Promise<string> =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const ofAccount = {
    rules: () => db.select().from(rules).where(eq(rules.accountId, own.accountId)),
    contacts: () => db.select().from(contacts).where(eq(contacts.accountId, own.accountId)),
    signals: () => db.select().from(learningSignals).where(eq(learningSignals.accountId, own.accountId)),
    moves: async () => (await db.select({ id: changeLog.entityId }).from(changeLog).where(and(
      eq(changeLog.accountId, own.accountId), eq(changeLog.entityType, "message"), eq(changeLog.op, "move"),
    ))).map((r) => r.id).sort(),
    audits: () => db.select().from(auditLog).where(eq(auditLog.accountId, own.accountId)),
  };
  return { db, own, newAccount, letter, inTx, file, desiredOf, ofAccount };
}

describe("a pass's deny on a letter its provider did not confirm", () => {
  it("files only the unconfirmed letters, NULL included, and writes nothing standing", async () => {
    const w = await world();
    const genuine = await w.letter(SENDER, "pass");
    const unconfirmed = [
      await w.letter(SENDER, "unavailable"), await w.letter(SENDER, null),
      await w.letter(SENDER, "fail"), await w.letter(SENDER, "unauthenticated"),
    ];
    const r = await w.file();
    expect(r.skipped).toBeUndefined();
    expect(r.rerouted.map((x) => x.messageId).sort()).toEqual([...unconfirmed].sort());
    expect(await w.desiredOf(genuine), "a confirmed letter was filed").toBe(SCREENER_FOLDER);
    for (const id of unconfirmed) expect(await w.desiredOf(id)).toBe(SPAM);
    expect(await w.ofAccount.moves()).toEqual([...unconfirmed].sort());
    expect(await w.ofAccount.rules(), "a rule was written").toEqual([]);
    expect(await w.ofAccount.contacts(), "a contact was written").toEqual([]);
    expect(await w.ofAccount.signals(), "a learning signal was written").toEqual([]);
  });

  it("never moves a letter the person put back, and reads no other account's letters", async () => {
    const w = await world();
    const putBack = await w.letter(SENDER, "unavailable");
    await w.db.update(folderState).set({ autoFilingUndoneAt: NOW }).where(eq(folderState.messageId, putBack));
    const elsewhere = await w.letter(SENDER, "unavailable", await w.newAccount());
    const filed = await w.letter(SENDER, "unavailable");
    const r = await w.file();
    expect(r.rerouted.map((x) => x.messageId)).toEqual([filed]);
    expect(await w.desiredOf(putBack), "a letter the person put back was filed").toBe(SCREENER_FOLDER);
    expect(await w.desiredOf(elsewhere), "another account's letter was filed").toBe(SCREENER_FOLDER);
  });

  it("narrowed to one letter, files it while it is held, unconfirmed and not put back, and nothing beside it", async () => {
    const w = await world();
    const genuine = await w.letter(SENDER, "pass");
    const advised = await w.letter(SENDER, "unavailable");
    const beside = await w.letter(SENDER, "unavailable");
    const putBack = await w.letter(SENDER, "unavailable");
    await w.db.update(folderState).set({ autoFilingUndoneAt: NOW }).where(eq(folderState.messageId, putBack));
    const filedBy = async (only: string) => (await w.file(SPAM, SENDER, only)).rerouted.map((x) => x.messageId);
    expect(await filedBy(genuine), "a confirmed letter was filed").toEqual([]);
    expect(await filedBy(putBack), "a letter the person put back was filed").toEqual([]);
    expect(await filedBy(advised)).toEqual([advised]);
    expect(await filedBy(advised), "a letter no longer held was filed again").toEqual([]);
    expect(await w.desiredOf(beside), "a letter rode advice bought on another").toBe(SCREENER_FOLDER);
    expect(await w.desiredOf(genuine)).toBe(SCREENER_FOLDER);
    expect(await w.ofAccount.moves()).toEqual([advised]);
  });

  it("records each letter it files as an automatic filing with its undo, and nothing it did not file", async () => {
    const w = await world();
    const filed = [await w.letter(SENDER, "unavailable"), await w.letter(SENDER, null)].sort();
    await w.letter(SENDER, "pass");
    await w.file();
    const rows = (await w.ofAccount.audits()).map((r) => ({
      action: r.action, payload: r.payload as { messageId: string }, inverse: r.inverse,
    })).sort((a, b) => a.payload.messageId.localeCompare(b.payload.messageId));
    expect(rows, "a filing with no rule left nothing to put it back by").toEqual(filed.map((messageId) => ({
      action: "screener_auto_apply_move",
      payload: { mailboxId: w.own.mailboxId, messageId, from: SCREENER_FOLDER, to: SPAM },
      inverse: { messageId, from: SPAM, to: SCREENER_FOLDER },
    })));
    expect((await w.file()).rerouted).toEqual([]);
    expect(await w.ofAccount.audits(), "a filing that moved nothing recorded one").toHaveLength(2);
  });

  for (const enabled of [true, false]) {
    it(`a sender whose key has a rule${enabled ? "" : " (paused)"} is not this filing's: nothing moves`, async () => {
      const w = await world();
      await w.db.insert(rules).values({
        accountId: w.own.accountId, kind: "sender", match: SENDER, destination: "INBOX", provenance: "manual", enabled,
      });
      const id = await w.letter(SENDER, "unavailable");
      const r = await w.file();
      expect(r).toMatchObject({ skipped: "ruled", rerouted: [] });
      expect(await w.desiredOf(id)).toBe(SCREENER_FOLDER);
      expect(await w.ofAccount.moves()).toEqual([]);
      expect(await w.ofAccount.audits()).toEqual([]);
    });
  }

  it("cannot admit: an admitting destination or the gate itself is refused before anything is written", async () => {
    const w = await world();
    const id = await w.letter(SENDER, "unavailable");
    for (const dest of ["INBOX", "ohmail/News", "ohmail/Reads", "ohmail/Receipts", SCREENER_FOLDER, "ohmail/Nowhere"]) {
      await expect(w.file(dest), dest).rejects.toThrow(/deny destination/);
    }
    expect(await w.desiredOf(id)).toBe(SCREENER_FOLDER);
    expect(await w.ofAccount.moves()).toEqual([]);
    // CONTROL: both deny destinations file.
    expect((await w.file("ohmail/Screened")).rerouted.map((x) => x.messageId)).toEqual([id]);
  });

  it("an erased account is refused before anything is written", async () => {
    const w = await world();
    const id = await w.letter(SENDER, "unavailable");
    await w.db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, w.own.accountId));
    await expect(w.file()).rejects.toBeInstanceOf(AccountErasedError);
    expect(await w.desiredOf(id)).toBe(SCREENER_FOLDER);
  });

  it("CONTROL: a person's deny on the same sender writes their rule and moves every held letter", async () => {
    const w = await world();
    const genuine = await w.letter(SENDER, "pass");
    const forged = await w.letter(SENDER, "unavailable");
    const r = await w.inTx((tx) => applyScreenerDecision(tx, {
      accountId: w.own.accountId, scope: "sender", address: SENDER, appliedFolder: SPAM, decision: "no",
      triggeringActionId: `screener:${forged}`, now: NOW, overExisting: "converge", decidedBy: "person",
    }));
    expect(r.rerouted.map((x) => x.messageId).sort()).toEqual([genuine, forged].sort());
    expect(await w.desiredOf(genuine)).toBe(SPAM);
    expect(await w.desiredOf(forged)).toBe(SPAM);
    const written = await w.ofAccount.rules();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: "sender", match: SENDER, destination: SPAM, provenance: "promoted", enabled: true });
    expect(written[0]!.personDecidedAt, "the person's press no longer stamps the rule").toEqual(NOW);
  });
});

/**
 * A PASS'S DENY THAT MAY NOT STAND AS A RULE ON A CONFIRMED LETTER (the crowd's cap, or a row stored
 * before its reason was): the filing moves exactly the advised held letter, whatever its verdict, and
 * nothing beside it; never one put back, deleted or sensitive (`no_ai`, a sensitivity category); and
 * writes nothing standing, each filing recorded with its undo. The same refusals as the door above.
 */
describe("a pass's deny filed as the one letter it was about", () => {
  const fileAdvised = (w: Awaited<ReturnType<typeof world>>, messageId: string, appliedFolder = SPAM, address = SENDER) =>
    w.inTx((tx) => rerouteAdvisedLetter(tx, { accountId: w.own.accountId, address, appliedFolder, now: NOW, messageId }));

  for (const verdict of ["pass", "unavailable", null] as const) {
    it(`files the advised letter (${String(verdict)}) and nothing beside it, with its undo and nothing standing`, async () => {
      const w = await world();
      const beside = [await w.letter(SENDER, "pass"), await w.letter(SENDER, "unavailable")];
      const advised = await w.letter(SENDER, verdict);
      const r = await fileAdvised(w, advised);
      expect(r.skipped).toBeUndefined();
      expect(r.rerouted.map((x) => x.messageId)).toEqual([advised]);
      expect(await w.desiredOf(advised)).toBe(SPAM);
      for (const id of beside) expect(await w.desiredOf(id), "a letter rode advice bought on another").toBe(SCREENER_FOLDER);
      expect(await w.ofAccount.moves()).toEqual([advised]);
      expect(await w.ofAccount.rules(), "a rule was written").toEqual([]);
      expect(await w.ofAccount.contacts(), "a contact was written").toEqual([]);
      expect(await w.ofAccount.signals(), "a learning signal was written").toEqual([]);
      expect((await w.ofAccount.audits()).map((a) => ({ action: a.action, payload: a.payload, inverse: a.inverse }))).toEqual([{
        action: "screener_auto_apply_move",
        payload: { mailboxId: w.own.mailboxId, messageId: advised, from: SCREENER_FOLDER, to: SPAM },
        inverse: { messageId: advised, from: SPAM, to: SCREENER_FOLDER },
      }]);
      expect((await fileAdvised(w, advised)).rerouted, "a letter no longer held was filed again").toEqual([]);
    });
  }

  it("MUTATION-WATCH: leaves a letter put back, deleted, marked no-AI or sensitive, and another sender's", async () => {
    const w = await world();
    const putBack = await w.letter(SENDER, "pass");
    await w.db.update(folderState).set({ autoFilingUndoneAt: NOW }).where(eq(folderState.messageId, putBack));
    const deleted = await w.letter(SENDER, "pass");
    await w.db.update(messages).set({ deletedAt: NOW }).where(eq(messages.id, deleted));
    const noAi = await w.letter(SENDER, "pass");
    await w.db.update(messages).set({ noAi: true }).where(eq(messages.id, noAi));
    const sensitive = await w.letter(SENDER, "pass");
    await w.db.update(messages).set({ sensitivityCategory: "otp" }).where(eq(messages.id, sensitive));
    const others = await w.letter("other@shop.test", "pass");
    for (const [id, what] of [[putBack, "put back"], [deleted, "deleted"], [noAi, "no-AI"], [sensitive, "sensitive"], [others, "another sender's"]] as const) {
      expect((await fileAdvised(w, id)).rerouted, `a ${what} letter was filed`).toEqual([]);
      expect(await w.desiredOf(id)).toBe(SCREENER_FOLDER);
    }
    expect(await w.ofAccount.moves()).toEqual([]);
    expect(await w.ofAccount.audits()).toEqual([]);
  });

  for (const enabled of [true, false]) {
    it(`a sender whose key has a rule${enabled ? "" : " (paused)"} is not this filing's: nothing moves`, async () => {
      const w = await world();
      await w.db.insert(rules).values({
        accountId: w.own.accountId, kind: "sender", match: SENDER, destination: "INBOX", provenance: "manual", enabled,
      });
      const id = await w.letter(SENDER, "pass");
      expect(await fileAdvised(w, id)).toMatchObject({ skipped: "ruled", rerouted: [] });
      expect(await w.desiredOf(id)).toBe(SCREENER_FOLDER);
      expect(await w.ofAccount.audits()).toEqual([]);
    });
  }

  it("cannot admit, and an erased account is refused, before anything is written", async () => {
    const w = await world();
    const id = await w.letter(SENDER, "pass");
    for (const dest of ["INBOX", "ohmail/News", "ohmail/Reads", "ohmail/Receipts", SCREENER_FOLDER, "ohmail/Nowhere"]) {
      await expect(fileAdvised(w, id, dest), dest).rejects.toThrow(/deny destination/);
    }
    expect(await w.desiredOf(id)).toBe(SCREENER_FOLDER);
    await w.db.update(accounts).set({ erasedAt: NOW }).where(eq(accounts.id, w.own.accountId));
    await expect(fileAdvised(w, id)).rejects.toBeInstanceOf(AccountErasedError);
    expect(await w.ofAccount.moves()).toEqual([]);
  });

  it("CONTROL: the other deny destination files it too", async () => {
    const w = await world();
    const id = await w.letter(SENDER, "pass");
    expect((await fileAdvised(w, id, "ohmail/Screened")).rerouted.map((x) => x.messageId)).toEqual([id]);
    expect(await w.desiredOf(id)).toBe("ohmail/Screened");
  });
});
