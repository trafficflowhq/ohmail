import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, folderState, mailboxFolders, mailboxes, messageBodies, messageInstances, messages, rules, type Tx,
} from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A BRAND AT AN `r|n` JUNCTION IS STILL CLAIMED (mail 0148), through a real sync cycle on the two
 * automatic admit routes: a person's allow domain rule and the reply arm (a message citing one of
 * the account's Sent copies). "Ihr N.e.t.f.l.i.x Konto" folds `rn` across the junction in one
 * reading and keeps Netflix's letters in the other, so every case waits at the Screener.
 */
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");

async function world(rule: string | null) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rnj-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: me, status: "connected", createdAt: CONNECT }).returning();
  if (rule) {
    await db.insert(rules).values({ accountId, kind: "domain", match: rule, destination: "INBOX", provenance: "manual", enabled: true });
  }
  // One Sent copy, so a message citing it takes the reply arm.
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
  const [sent] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sent:${randomUUID()}`, subject: "Liste", fromAddress: me,
    messageIdHeader: "s-1@own.invalid", date: WROTE, arrivedAt: WROTE,
    toAddresses: [{ name: null, address: "list@lists.invalid" }], ccAddresses: [], nativeLocator: { folder: "Sent", ref: "7:1" },
  }).returning();
  await db.insert(messageInstances).values({ accountId, mailboxId: mb!.id, messageId: sent!.id, folder: "Sent", uidvalidity: 7n, uid: 1, isPrimary: true });
  await db.insert(folderState).values({
    messageId: sent!.id, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  await db.insert(messageBodies).values({ messageId: sent!.id, text: "hi", headers: {} });
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } });
  const queue: Array<{ from: string; subject: string; messageId: string; headers?: string[] }> = [];
  return async (from: string, subject: string, headers?: string[]) => {
    queue.push({ from, subject, messageId: `m-${randomUUID()}@x.invalid`, ...(headers ? { headers } : {}) });
    fleet.behave(mb!.id, { deliver: [...queue] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    const [row] = await db.select({ check: messages.senderCheck, brand: messages.senderCheckBrand, desired: folderState.desiredFolder })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId), eq(messages.subject, subject)));
    return row!;
  };
}

const HELD = { desired: "ohmail/Screener", check: "impersonation", brand: "Netflix" };
const SUBJ = (n: number) => `Zahlung fehlgeschlagen - Konto ${n}`;
const CITES = ["In-Reply-To: <s-1@own.invalid>"];

describe("a brand at an r|n junction through real ingest", () => {
  it("under a person's allow domain rule: the dotted and the glued forms wait at the Screener", async () => {
    let deliver = await world("partner-firma.invalid");
    expect(await deliver(`"Ihr N.e.t.f.l.i.x Konto" <service@partner-firma.invalid>`, SUBJ(1))).toEqual(HELD);
    deliver = await world("partner-firma.invalid");
    expect(await deliver(`"YourNetflix" <service@partner-firma.invalid>`, SUBJ(2))).toEqual(HELD);
    deliver = await world("partner-firma.invalid");
    expect(await deliver(`"ElsterNachricht" <service@partner-firma.invalid>`, SUBJ(3)))
      .toEqual({ ...HELD, brand: "ELSTER" });
  });

  it("under a person's allow domain rule: a word glued before a split brand waits at the Screener", async () => {
    for (const [n, name] of (["MyPost Finance", "MeinPost Finance", "IhrPost-Finance"] as const).entries()) {
      const deliver = await world("partner-firma.invalid");
      expect(await deliver(`"${name}" <service@partner-firma.invalid>`, SUBJ(10 + n)), name).toEqual({ ...HELD, brand: "PostFinance" });
    }
    // Three worlds through real ingest, no wait of its own: 0.9 s as a rule, 2.7 s once on a loaded CI
    // VM, 77 s under 10% of a CPU.
  }, 120_000);

  it("on the reply arm: a message citing a Sent copy is held with the claim", async () => {
    const deliver = await world(null);
    expect(await deliver(`"Ihr N.e.t.f.l.i.x Konto" <${personalAt("fixture.mila", "gmail.com")}>`, SUBJ(4), CITES)).toEqual(HELD);
  });

  it("CONTROLS: the plain spelling is held on both routes, and a person's ordinary name is admitted", async () => {
    let deliver = await world("partner-firma.invalid");
    expect(await deliver(`"Netflix Konto" <service@partner-firma.invalid>`, SUBJ(5))).toEqual(HELD);
    deliver = await world(null);
    expect(await deliver(`"Netflix Konto" <${personalAt("fixture.mila", "gmail.com")}>`, SUBJ(6), CITES)).toEqual(HELD);
    deliver = await world("partner-firma.invalid");
    expect(await deliver(`"Bernard Arnold" <b.arnold@partner-firma.invalid>`, SUBJ(7)))
      .toEqual({ desired: "INBOX", check: "none", brand: null });
  });
});
