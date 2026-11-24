import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb, TEST_DIALECT_ENV } from "../src/testing.js";
import { accounts as pgAccounts, messages as pgMessages, mailboxes as pgMailboxes } from "../src/schema-mail.js";
import { accounts as sqliteAccounts, messages as sqliteMessages, mailboxes as sqliteMailboxes } from "../src/schema-mail-sqlite.js";
import { readScreenerLearning, changeScreenerLearning, updateScreenerLearning } from "../src/screener-learning.js";
import { recordScreenerChoice, reviseScreenerDecision } from "../src/screener-learning-choice.js";
import { carryDialect } from "../src/dialect/index.js";
import { stampMailboxErasure } from "../src/mailbox-erasure.js";

const sqlite = process.env[TEST_DIALECT_ENV] === "sqlite";
const accounts = (sqlite ? sqliteAccounts : pgAccounts) as typeof pgAccounts;
const mailboxes = (sqlite ? sqliteMailboxes : pgMailboxes) as typeof pgMailboxes;
const messages = (sqlite ? sqliteMessages : pgMessages) as typeof pgMessages;
const now = new Date("2026-11-24T12:00:00Z");

async function fixture() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId });
  const scopes = [1, 2].map(i => ({ accountId, mailboxId: randomUUID(), i }));
  for (const { mailboxId, i } of scopes) {
    await db.insert(mailboxes).values({ id: mailboxId, accountId, provider: "imap", address: `sample${i}@example.test` });
  }
  return { db, first: scopes[0]!, second: scopes[1]! };
}

describe("Screener learning on a mailbox", () => {
  it("defaults to learning with a pending notice and keeps the switch per mailbox", async () => {
    const { db, first, second } = await fixture();
    expect(await readScreenerLearning(db, first, now)).toMatchObject({ enabled: true, notice: true, text: "", lessons: [] });
    await changeScreenerLearning(db, first, { kind: "enable", enabled: false }, now);
    expect(await readScreenerLearning(db, first, now)).toMatchObject({ enabled: false, notice: false });
    expect(await readScreenerLearning(db, second, now)).toMatchObject({ enabled: true, notice: true });
  });

  it("denies another account and removes the setting at mailbox erasure", async () => {
    const { db, first } = await fixture();
    const other = { ...first, accountId: randomUUID() };
    expect(await changeScreenerLearning(db, other, { kind: "enable", enabled: false }, now)).toBeNull();
    expect(await readScreenerLearning(db, other, now)).toBeNull();
    await changeScreenerLearning(db, first, { kind: "enable", enabled: false }, now);
    await db.transaction(tx => stampMailboxErasure(tx, { ...first, now }));
    expect(await changeScreenerLearning(db, first, { kind: "enable", enabled: true }, now)).toBeNull();
    expect(await readScreenerLearning(db, first, now)).toBeNull();
  });
});


it("stores a generic lesson after the notice and withdraws it on undo", async () => {
  const { db, first, second } = await fixture();
  const messageId = randomUUID(), decisionId = randomUUID();
  await db.insert(messages).values({
    id: messageId, accountId: first.accountId, mailboxId: first.mailboxId, subject: "Einladung zum Webinar",
    dedupKey: "example", bodyHash: "example", fromAddress: "sample@example.test", noAi: false,
  });
  const choice = { messageId, decisionId, actionId: "choice", chosen: "ohmail/Screened", at: now };
  const record = (scope: typeof first) => db.transaction(tx => recordScreenerChoice(carryDialect(db, tx), scope, choice));
  await record(first);
  expect((await readScreenerLearning(db, first, now))?.lessons).toHaveLength(0);
  await changeScreenerLearning(db, first, { kind: "notice" }, now);
  await record(second);
  await record(first);
  await record(first);
  const state = await readScreenerLearning(db, first, now);
  expect(state?.lessons).toEqual([expect.objectContaining({
    kind: "independent", topic: "webinar", chosen: "ohmail/Screened", suggested: null, previous: null,
  })]);
  expect(JSON.stringify(state)).not.toMatch(/Einladung|example\.test/);
  await db.transaction(tx => reviseScreenerDecision(carryDialect(db, tx), first.accountId, decisionId, now));
  expect((await readScreenerLearning(db, first, now))?.lessons).toEqual([]);
});


it("forgets one lesson, clears the note, and preserves the remaining lesson", async () => {
  const { db, first } = await fixture();
  const firstId = "a".repeat(64), secondId = "b".repeat(64);
  await updateScreenerLearning(db, first, state => ({
    ...state, notice: false, text: "Webinar-Einladungen aussortieren. Keep shop receipts in Receipts.",
    lessons: [
      { id: firstId, decisionId: firstId, messageRef: firstId, at: now.getTime(),
        kind: "independent", suggested: null, previous: null, chosen: "ohmail/Screened", topic: "webinar" },
      { id: secondId, decisionId: secondId, messageRef: secondId, at: now.getTime(),
        kind: "independent", suggested: null, previous: null, chosen: "ohmail/Receipts", topic: "receipt" },
    ],
  }));
  const next = await changeScreenerLearning(db, first, { kind: "forget", id: firstId }, now);
  expect(next).toMatchObject({ text: "", updatedAt: null });
  expect(next?.lessons.map(lesson => lesson.id)).toEqual([secondId]);
});
