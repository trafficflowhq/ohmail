import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, contacts, folderState, mailboxes, messageBodies, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { runSensitiveRescreen } from "../src/sensitive-rescreen.js";
import type { Db } from "../src/context.js";

/**
 * THE RE-SCREEN NEVER MOVES OHBOX MAIL BECAUSE OF THE IDENTITY FACT (hotfix 0.25.19). The fact holds
 * mail at arrival only; this pass re-routes mail already in the Ohbox. An inferred contact's code
 * whose name claims a company it does not send from stays where it is, checked or not; a stranger's
 * code still moves (the control). PGlite.
 */
const OHBOX = "INBOX";
const SCREENER = "ohmail/Screener";

async function world() {
  const db = (await makeTestDb()) as unknown as Db;
  const t = db as unknown as Tx;
  const accountId = randomUUID();
  await t.insert(accounts).values({ id: accountId, name: `rsc-${accountId.slice(0, 8)}` });
  const [mb] = await t.insert(mailboxes).values({ accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid` }).returning();
  const seed = async (from: string, fromName: string, senderCheck: "impersonation" | null): Promise<string> => {
    const [m] = await t.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `rsc:${randomUUID()}`,
      subject: "Your verification code", fromAddress: from, fromName, sensitivityCategory: "otp",
      senderCheck, senderCheckBrand: senderCheck ? "PostFinance" : null,
      nativeLocator: { folder: OHBOX, ref: `1:${Math.floor(Math.random() * 100000)}` },
    }).returning();
    await t.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await t.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: OHBOX, observedFolder: OHBOX, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  const desiredOf = async (id: string) =>
    (await t.select().from(folderState).where(eq(folderState.messageId, id)))[0]!.desiredFolder;
  return { db, t, accountId, mailboxId: mb!.id, seed, desiredOf };
}

describe("runSensitiveRescreen and the identity fact", () => {
  it("an inferred contact's code naming a company stays in the Ohbox, checked or not; a stranger's moves", async () => {
    const w = await world();
    await w.t.insert(contacts).values({ accountId: w.accountId, address: "codes@kartenpartner.invalid", source: "inferred" });
    await w.t.insert(contacts).values({ accountId: w.accountId, address: "otp@kartenpartner.invalid", source: "inferred" });
    const checked = await w.seed("codes@kartenpartner.invalid", "PostFinance", "impersonation");
    const unchecked = await w.seed("otp@kartenpartner.invalid", "PostFinance", null);
    const stranger = await w.seed("someone@stranger.invalid", "Someone", null);

    const r = await runSensitiveRescreen({ db: w.db, mailboxId: w.mailboxId, trustedAuthservIdsFor: async () => new Set<string>() });

    expect(r.rescreened).toBe(1);
    expect(await w.desiredOf(checked)).toBe(OHBOX);
    expect(await w.desiredOf(unchecked)).toBe(OHBOX);
    expect(await w.desiredOf(stranger)).toBe(SCREENER);
  });
});
