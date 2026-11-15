import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, folderState, mailboxFolders, mailboxes, messageBodies, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { screenerCorrespondentRetroPass } from "../src/screener-correspondent-retro.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * The server's record: an answer the gate admits as an answer to the account's own
 * writing is decided for that letter (`folder_state.decided_at`), through the real ingest and through
 * the correspondent retro's release of an answer held before its copy synced. The world is
 * `correspondent-retro-holds-the-claim.test.ts`'s: a Sent copy to a third party, an answer from
 * another address citing it.
 */

const ANSWERER = "b+r31x@answers.invalid";
const LANDLORD = "landlord@corr.invalid";
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");
const CITES = ["In-Reply-To: <s-1@own.invalid>"];

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `r31-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: me, status: "connected", createdAt: CONNECT }).returning();
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, accountId: mb!.accountId, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
  const [s] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sent:${randomUUID()}`,
    subject: "Wohnung", fromAddress: me, messageIdHeader: "s-1@own.invalid",
    date: WROTE, arrivedAt: WROTE, toAddresses: [{ name: null, address: LANDLORD }], ccAddresses: [],
    nativeLocator: { folder: "Sent", ref: "7:1" },
  }).returning();
  await db.insert(messageInstances).values({
    accountId, mailboxId: mb!.id, messageId: s!.id, folder: "Sent", uidvalidity: 7n, uid: 1, isPrimary: true,
  });
  await db.insert(folderState).values({
    messageId: s!.id, accountId: s!.accountId, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us",
    reconcileStatus: "reconciled", conflict: false,
  });
  await db.insert(messageBodies).values({ messageId: s!.id, accountId: s!.accountId, text: "hi", headers: {} });

  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } },
  );
  const queue: Array<{ from: string; subject: string; messageId: string; headers?: string[] }> = [];
  const deliver = async (from: string, subject: string, headers?: string[]) => {
    queue.push({ from, subject, messageId: `m-${randomUUID()}@answers.invalid`, ...(headers ? { headers } : {}) });
    fleet.behave(mb!.id, { deliver: [...queue] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    const [row] = await db.select({ id: messages.id, desired: folderState.desiredFolder, decidedAt: folderState.decidedAt })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId), eq(messages.subject, subject)));
    return row!;
  };
  const stateOf = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder, at: folderState.decidedAt }).from(folderState)
      .where(eq(folderState.messageId, id)))[0]!;
  return { db, accountId, deliver, stateOf };
}

describe("an answer the gate admits is decided for that letter", () => {
  it("the ingest's reply arm states the decision beside the admission", async () => {
    const w = await world();
    const answer = await w.deliver(`"B" <${ANSWERER}>`, "Thursday works", CITES);
    expect(answer.desired).toBe("INBOX");
    expect(answer.decidedAt).not.toBeNull();
  });

  it("the retro's release of an answer held before its copy synced states it too", async () => {
    const w = await world();
    const answer = await w.deliver(`"B" <${ANSWERER}>`, "Thursday works", CITES);
    await w.db.update(folderState).set({ desiredFolder: "ohmail/Screener", lastSetBy: "us", decidedAt: null })
      .where(eq(folderState.messageId, answer.id));
    const r = await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(r.released).toBe(1);
    const after = await w.stateOf(answer.id);
    expect(after.d).toBe("INBOX");
    expect(after.at).not.toBeNull();
  });

  it("CONTROL: a stranger's letter the gate holds carries no decision", async () => {
    const w = await world();
    const held = await w.deliver(`"C" <c+fresh@stranger.invalid>`, "Hello there");
    expect(held.desired).toBe("ohmail/Screener");
    expect(held.decidedAt).toBeNull();
  });
});
