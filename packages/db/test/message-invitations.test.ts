import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, messageInvitations, messages } from "../src/index.js";
import { makeTestDb } from "../src/testing.js";

/**
 * AN INVITATION'S IDENTITY IS ITS LETTER'S CHILD (mail 0204), on whichever store the run is (the
 * sqlite project runs this file too): one row per letter, read back as it was written, and gone
 * with the letter without a statement of its own.
 */
async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "invitations" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `i-${accountId}@example.test` }).returning();
  const letter = async (): Promise<string> => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, dedupKey: `mid:<${randomUUID()}@example.test>`, bodyHash: "b",
    }).returning();
    return m!.id;
  };
  return { db, accountId, mailboxId: mb!.id, letter };
}

describe("the identity of an invitation a letter carried", () => {
  it("is stored once per letter and read back as written, the series by default", async () => {
    const w = await world();
    const messageId = await w.letter();
    const startsAt = new Date("2026-12-01T10:00:00.000Z");
    await w.db.insert(messageInvitations).values({
      accountId: w.accountId, messageId, mailboxId: w.mailboxId, uid: "040000008200E00074C5B7101A82E008@example.test",
      method: "REQUEST", startRaw: "TZID=Europe/Zurich:20261201T110000", startsAt,
      organizer: "organizer@example.test", invitedAddress: "me@example.test",
    });
    const [row] = await w.db.select().from(messageInvitations).where(eq(messageInvitations.messageId, messageId));
    expect(row).toMatchObject({
      accountId: w.accountId, messageId, mailboxId: w.mailboxId, uid: "040000008200E00074C5B7101A82E008@example.test",
      recurrenceId: "", sequence: 0, method: "REQUEST", startRaw: "TZID=Europe/Zurich:20261201T110000", startsAt,
      organizer: "organizer@example.test", invitedAddress: "me@example.test",
    });
    expect(row!.createdAt).toBeInstanceOf(Date);
    // One card per letter: a second row for the same letter is refused.
    await expect(w.db.insert(messageInvitations).values({
      accountId: w.accountId, messageId, mailboxId: w.mailboxId, uid: "another@example.test", method: "CANCEL",
    })).rejects.toThrow();
  });

  it("goes with its letter, and only with its own", async () => {
    const w = await world();
    const [gone, kept] = [await w.letter(), await w.letter()];
    for (const messageId of [gone, kept]) {
      await w.db.insert(messageInvitations).values({
        accountId: w.accountId, messageId, mailboxId: w.mailboxId, uid: `${messageId}@example.test`, method: "REQUEST",
      });
    }
    await w.db.delete(messages).where(eq(messages.id, gone));
    const left = await w.db.select({ messageId: messageInvitations.messageId }).from(messageInvitations)
      .where(eq(messageInvitations.accountId, w.accountId));
    expect(left).toEqual([{ messageId: kept }]);
  });

  it("is refused for a letter that is not there", async () => {
    const w = await world();
    await expect(w.db.insert(messageInvitations).values({
      accountId: w.accountId, messageId: randomUUID(), mailboxId: w.mailboxId, uid: "orphan@example.test", method: "REQUEST",
    })).rejects.toThrow();
  });
});
