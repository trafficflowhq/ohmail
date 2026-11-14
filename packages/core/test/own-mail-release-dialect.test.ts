import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { changeLog, folderState, mailboxes, messages, rules } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { makeTestDb } from "@trafficflow/db/testing";
import { DrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * THE OWN-MAIL RELEASE AND THE OWN-ADDRESS READ, ON BOTH STORES. The sidecar composes the worker's
 * visit over the device store too, so the release statement and the ingest's page read run there.
 * Registered in `vitest.sqlite.config.ts`. Addresses are `.invalid`.
 */
const GATE = "ohmail/Screener";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "Me@Own.invalid", status: "connected" }).returning();
  await db.insert(mailboxes).values({ accountId, provider: "imap", address: "ruled@own-too.invalid" });
  let n = 0;
  const seed = async (from: string, lastSetBy: string, authVerdict: string | null = null) => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, dedupKey: `own:${randomUUID()}`, bodyHash: `h${i}`,
      subject: "s", fromAddress: from, authVerdict, nativeLocator: { folder: GATE, ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE,
      lastSetBy, reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  const desiredOf = async (id: string) =>
    (await db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!.desiredFolder;
  const release = (limit: number) => db.transaction(async (tx) =>
    new DrizzleRepo(tx as never, dialect(db)).releaseOwnMailAtGate(accountId, mb!.id, limit));
  return { db, accountId, seed, desiredOf, release };
}

describe("own mail at the gate, on both stores", () => {
  it("the own set is the account's mailboxes neither erased nor removed, case-folded", async () => {
    const w = await world();
    expect([...await new DrizzleRepo(w.db as never).ownAddresses(w.accountId)].sort())
      .toEqual(["me@own.invalid", "ruled@own-too.invalid"]);
  });

  it("own mail an organizer filed moves back, bounded; a person's, a failed one, a ruled one and a stranger's stay", async () => {
    const w = await world();
    const ours = await w.seed("me@own.invalid", "us");
    const ours2 = await w.seed("ME@OWN.INVALID", "us", "unavailable");
    // Met at the gate on this install's first read: the previous organizer's filing.
    const peers = await w.seed("me@own.invalid", "peer");
    const person = await w.seed("me@own.invalid", "external");
    const forged = await w.seed("me@own.invalid", "us", "fail");
    const stranger = await w.seed("someone@stranger.invalid", "us");
    const ruled = await w.seed("ruled@own-too.invalid", "us");
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "ruled@own-too.invalid", destination: GATE,
      priority: 0, provenance: "manual", enabled: true,
    });

    expect(await w.release(1)).toBe(1);
    expect(await w.release(100)).toBe(2);
    expect(await w.release(100)).toBe(0);
    expect(await w.desiredOf(ours)).toBe("INBOX");
    expect(await w.desiredOf(ours2)).toBe("INBOX");
    expect(await w.desiredOf(peers)).toBe("INBOX");
    for (const kept of [person, forged, stranger, ruled]) expect(await w.desiredOf(kept)).toBe(GATE);
    const moves = await w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId));
    expect(moves.filter((c) => c.op === "move").map((c) => c.entityId).sort()).toEqual([ours, ours2, peers].sort());
  });
});
