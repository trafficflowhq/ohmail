import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, folderState, mailboxes, messageBodies, messages, threads, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { runSensitiveRescreen } from "../src/sensitive-rescreen.js";
import type { Db } from "../src/context.js";

/**
 * THE RE-SCREEN PASS NEVER MOVES THE ACCOUNT'S OWN MAIL INTO THE GATE. It moves Ohbox mail the
 * router now answers `screener` for; the account's own address is not first contact, so a code it
 * sent itself stays in the Ohbox. A stranger's still moves (the control). PGlite.
 */

const OHBOX = "INBOX";
const SCREENER = "ohmail/Screener";

async function world() {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  await db.insert(accounts).values({ id: accountId, name: `own-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
  await db.insert(mailboxes).values({ accountId, provider: "imap", address: "second@own-too.invalid" });
  const seed = async (from: string): Promise<string> => {
    const [m] = await (db as unknown as Tx).insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `own:${randomUUID()}`,
      subject: "Your verification code", fromAddress: from, sensitivityCategory: "otp",
      nativeLocator: { folder: OHBOX, ref: `1:${Math.floor(Math.random() * 100000)}` },
    }).returning();
    await (db as unknown as Tx).insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await (db as unknown as Tx).insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: OHBOX, observedFolder: OHBOX,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  const desiredOf = async (id: string) =>
    (await (db as unknown as Tx).select().from(folderState).where(eq(folderState.messageId, id)))[0]!.desiredFolder;
  return { db, mailboxId: mb!.id, me, seed, desiredOf };
}

describe("runSensitiveRescreen and the account's own addresses", () => {
  it("own mail stays in the Ohbox, from either of the account's mailboxes; a stranger's is screened", async () => {
    const w = await world();
    const mine = await w.seed(w.me);
    const other = await w.seed("Second@Own-Too.invalid");
    const stranger = await w.seed("someone@stranger.invalid");

    const r = await runSensitiveRescreen({
      db: w.db, mailboxId: w.mailboxId, trustedAuthservIdsFor: async () => new Set<string>(),
    });

    expect(r.rescreened).toBe(1);
    expect(await w.desiredOf(mine)).toBe(OHBOX);
    expect(await w.desiredOf(other)).toBe(OHBOX);
    expect(await w.desiredOf(stranger)).toBe(SCREENER);
  });
});

/**
 * EXCLUSION 5 ASKS WHETHER THE PERSON ANSWERED THIS SENDER, not whether the thread holds any
 * own-address message. The re-screen read the away responder's reply, and our reply to somebody
 * else, as the person having dealt with a stranger's code, and so never re-screened it. Four
 * thread shapes, one stranger's code each: the two that must move, and the two controls.
 */
describe("runSensitiveRescreen asks the one engagement question", () => {
  const STRANGER = "someone@stranger.invalid";

  async function threaded(ours: { to: string[]; machine: boolean } | null) {
    const db = (await makeTestDb()) as unknown as Db;
    const t = db as unknown as Tx;
    const accountId = randomUUID();
    const me = `me-${accountId.slice(0, 8)}@own.invalid`;
    await t.insert(accounts).values({ id: accountId, name: `rs-${accountId.slice(0, 8)}` });
    const [mb] = await t.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
    const [th] = await t.insert(threads).values({ accountId }).returning();
    const [m] = await t.insert(messages).values({
      accountId, mailboxId: mb!.id, threadId: th!.id, bodyHash: "h", dedupKey: `rs:${randomUUID()}`,
      messageIdHeader: `c-${randomUUID()}@stranger.invalid`, subject: "Your verification code",
      fromAddress: STRANGER, sensitivityCategory: "otp",
      nativeLocator: { folder: OHBOX, ref: `1:${Math.floor(Math.random() * 100000)}` },
    }).returning();
    await t.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await t.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: OHBOX, observedFolder: OHBOX,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    if (ours) {
      const [s] = await t.insert(messages).values({
        accountId, mailboxId: mb!.id, threadId: th!.id, bodyHash: "h2", dedupKey: `rs:${randomUUID()}`,
        messageIdHeader: `${randomUUID()}@own.invalid`, subject: "Re: Your verification code",
        fromAddress: me, nativeLocator: { folder: "Sent", ref: `1:${Math.floor(Math.random() * 100000)}` },
        toAddresses: ours.to.map((address) => ({ address, name: "" })),
      }).returning();
      // The responder's reply is marked the way every one it sends is: `Auto-Submitted`.
      await t.insert(messageBodies).values({
        messageId: s!.id, accountId: s!.accountId, text: "r", html: null,
        headers: { "auto-submitted": [ours.machine ? "auto-replied" : "no"] },
      });
      await t.insert(folderState).values({
        messageId: s!.id, accountId: s!.accountId, desiredFolder: "Sent", observedFolder: "Sent",
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
    }
    await runSensitiveRescreen({
      db, mailboxId: mb!.id, trustedAuthservIdsFor: async () => new Set<string>(),
    });
    return (await t.select().from(folderState).where(eq(folderState.messageId, m!.id)))[0]!.desiredFolder;
  }

  it("the away responder's reply to them is not the person answering — the code is re-screened", async () => {
    expect(await threaded({ to: [STRANGER], machine: true })).toBe(SCREENER);
  });

  it("our reply to somebody else on the thread is not an answer to them — re-screened", async () => {
    expect(await threaded({ to: ["colleague@else.invalid"], machine: false })).toBe(SCREENER);
  });

  it("CONTROL — our own reply to them keeps the code in the Ohbox", async () => {
    expect(await threaded({ to: [STRANGER], machine: false })).toBe(OHBOX);
  });

  it("CONTROL — a thread with nothing of ours is re-screened, so the fixture is a candidate", async () => {
    expect(await threaded(null)).toBe(SCREENER);
  });
});
