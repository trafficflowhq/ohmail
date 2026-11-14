import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, calConnections } from "../src/schema-mail.js";
import { calPushChannels, mailboxOauthCeremonies, mailboxOauthDeviceCeremonies } from "../src/schema-cloud.js";
import { makeTestDb } from "../src/testing.js";

/**
 * CLOUD 0105: what a sign-in ceremony connects, and the channels a calendar's provider notifies on.
 * A mailbox's flow names no purpose and its row says `mailbox`; a channel belongs to the account
 * of its connection and is found by `(provider, channel_id)` alone.
 */
const LATER = new Date(Date.now() + 3_600_000);
const stateOf = async (attempt: Promise<unknown>): Promise<string> => {
  try { await attempt; return "accepted"; } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "refused without a state";
  }
};

async function world() {
  const db = await makeTestDb();
  const [a] = await db.insert(accounts).values({ name: "calendar-a" }).returning();
  const [b] = await db.insert(accounts).values({ name: "calendar-b" }).returning();
  const [conn] = await db.insert(calConnections).values({ accountId: a!.id, provider: "google" }).returning();
  return { db, a: a!.id, b: b!.id, connectionId: conn!.id };
}

describe("a sign-in ceremony says what it connects", () => {
  it("a mailbox's ceremony, written as the mailbox flows write it, connects a mailbox", async () => {
    const { db, a } = await world();
    const [redirect] = await db.insert(mailboxOauthCeremonies).values({
      state: `s-${randomUUID()}`, accountId: a, provider: "microsoft", codeVerifierEnc: "sealed", codeVerifierKeyVersion: 1,
    }).returning();
    const [device] = await db.insert(mailboxOauthDeviceCeremonies).values({
      state: `s-${randomUUID()}`, accountId: a, provider: "microsoft", deviceCodeEnc: "sealed", deviceCodeKeyVersion: 1,
      userCode: "ABCD-EFGH", verificationUri: "https://login.example.test/device", pollIntervalMs: 5_000,
      grantExpiresAt: LATER,
    }).returning();
    expect([redirect!.purpose, device!.purpose]).toEqual(["mailbox", "mailbox"]);
  });
});

describe("a calendar's notice channel", () => {
  const channel = (accountId: string, connectionId: string, channelId: string) =>
    ({ accountId, connectionId, provider: "google", channelId, tokenHash: "h".repeat(64), expiresAt: LATER });

  it("belongs to the account of its connection", async () => {
    const { db, a, b, connectionId } = await world();
    expect(await stateOf(db.insert(calPushChannels).values(channel(a, connectionId, "ch-1")))).toBe("accepted");
    // Another account's row may not hang off this connection, and neither may a connection that is not there.
    expect(await stateOf(db.insert(calPushChannels).values(channel(b, connectionId, "ch-2")))).toBe("23503");
    expect(await stateOf(db.insert(calPushChannels).values(channel(a, randomUUID(), "ch-3")))).toBe("23503");
  });

  it("is found by its provider and its id alone: one row answers", async () => {
    const { db, a, connectionId } = await world();
    await db.insert(calPushChannels).values(channel(a, connectionId, "ch-1"));
    expect(await stateOf(db.insert(calPushChannels).values(channel(a, connectionId, "ch-1")))).toBe("23505");
    expect(await stateOf(db.insert(calPushChannels).values({ ...channel(a, connectionId, "ch-1"), provider: "microsoft" }))).toBe("accepted");
  });
});
