import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { accounts, contacts, drafts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  UNMETERED_STORAGE_CAP, type OpenSendAdapter, type OutboundMessage,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { SendService, type ServiceContext } from "../src/index.js";

/**
 * ═══ SOMEBODY YOU HAVE WRITTEN TO IS NOT A STRANGER ══════════════════════════════════════════
 *
 * `contacts` is what the routing layer reads as "senders this account knows" — the Screener holds
 * first contact from anybody who is not in it. Its writers were the consent seed and a
 * connect-time kickstart that has since been retired for reading consent off a folder listing. So
 * nothing kept the address book current: somebody you first wrote to last week was still a
 * stranger when they answered, and their reply was held for a consent you had already given by
 * writing to them.
 *
 * Writing to somebody is the person's own act, now, in ohmail — which is what makes this
 * different from the pass that was retired. The write rides `finalizeSent`'s transaction, the one
 * every successful send wins exactly once, and NOT the Sent projection: that one is best-effort,
 * never throws, and is skipped entirely for an adapter that cannot report what it appended. The
 * last case here drives exactly that adapter.
 *
 * REAL POSTGRES: the claim is about a write inside a compare-and-swap transaction, and about an
 * `ON CONFLICT DO NOTHING` against a unique — neither means anything without real constraints.
 * Every read is scoped to this file's own random accounts, so it is a safe co-tenant.
 */
const PG_UP = await realPgAvailable();

const sql = postgres(PG_TEST_URL, { max: 8, onnotice: () => {} });
const db = brandDialect(drizzle(sql, { schema }), "pg");
const svc = new SendService();
const NOW = new Date("2026-09-22T09:00:00.000Z");
const SENT = "Sent";

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sql.end({ timeout: 5 }); });

/**
 * An adapter that ERASES THE ACCOUNT between the reservation and the finalize — the window where
 * the SMTP submission is in flight and the Art. 17 sweep commits. The mail still went.
 */
function erasingAdapter(accountId: string): OpenSendAdapter {
  return async () => ({
    async send(msg: OutboundMessage) {
      await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, accountId));
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return true; },
    async close() { /* nothing to tear down */ },
  });
}

/** The ordinary adapter: SMTP, then an APPEND it can report. */
function appendingAdapter(): OpenSendAdapter {
  return async () => ({
    async send(msg: OutboundMessage) {
      const raw = Buffer.from([
        `Message-ID: ${msg.messageId!}`, `To: ${[msg.to ?? []].flat().map((a) => (typeof a === "string" ? a : a.address)).join(", ")}`,
        "Subject: hello", "", "hello", "",
      ].join("\r\n"));
      return {
        providerMessageId: msg.messageId!,
        appended: { locator: { folder: SENT, ref: `77:${Math.floor(Math.random() * 1e5)}` }, raw },
      };
    },
    async messageInSent() { return true; },
    async close() { /* nothing to tear down */ },
  });
}

/**
 * AN ADAPTER THAT CANNOT SAY WHAT IT APPENDED — a spy, or a provider that files Sent its own way.
 * `projectSentCopy` returns immediately for this one, so anything hung off the projection learns
 * nothing. The mail still went.
 */
function silentAdapter(): OpenSendAdapter {
  return async () => ({
    async send(msg: OutboundMessage) { return { providerMessageId: msg.messageId! }; },
    async messageInSent() { return true; },
    async close() { /* nothing to tear down */ },
  });
}

async function seeded(to: string[], opts: { cc?: string[]; bcc?: string[] } = {}) {
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.test`, status: "connected",
  }).returning();
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "hello", body: "hello",
    to: to.map((address) => ({ name: null, address })),
    ...(opts.cc ? { cc: opts.cc.map((address) => ({ name: null, address })) } : {}),
    ...(opts.bcc ? { bcc: opts.bcc.map((address) => ({ name: null, address })) } : {}),
    status: "draft",
  }).returning();
  const ctx: ServiceContext = {
    db: db as unknown as ServiceContext["db"],
    accountId, userId: null, now: () => NOW, requestId: "r",
  };
  return { accountId, mailboxId: mb!.id, draftId: d!.id, ctx };
}

const known = async (accountId: string): Promise<ReadonlySet<string>> =>
  (await makeDrizzleRepo(db as never).knownSenders(accountId)).addresses;

const contactRows = (accountId: string) =>
  db.select({ address: contacts.address }).from(contacts).where(eq(contacts.accountId, accountId));

describe.skipIf(!PG_UP)("the contact is learned at the send", () => {
  it("ACCEPTANCE: every recipient of a sent message is known to the Screener afterwards", async () => {
    const { accountId, draftId, ctx } = await seeded(
      ["nora@partner.test"], { cc: ["sam@partner.test"], bcc: ["blind@partner.test"] },
    );

    const res = await svc.send(ctx, draftId, `learn-${randomUUID()}`, {
      openSendAdapter: appendingAdapter(), resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
    });
    expect(res.status).toBe("sent");

    // Through the READER the routing layer actually uses, not a direct table read: a row nobody
    // can see is not a contact.
    const set = await known(accountId);
    expect(set.has("nora@partner.test")).toBe(true);
    expect(set.has("sam@partner.test"), "a Cc is somebody you wrote to").toBe(true);
    // Bcc keeps the recipient list off the wire. It does not make them a stranger to you.
    expect(set.has("blind@partner.test"), "a Bcc is somebody you wrote to").toBe(true);
  });

  it("a second send to the same person adds no second row", async () => {
    const { accountId, ctx } = await seeded(["nora@partner.test"]);
    for (let i = 0; i < 2; i++) {
      const [d] = await db.insert(drafts).values({
        accountId, mailboxId: (await db.select({ id: mailboxes.id }).from(mailboxes)
          .where(eq(mailboxes.accountId, accountId)))[0]!.id,
        // The content must DIFFER: an identical second message is refused by the account's own
        // duplicate-send fingerprint, which has nothing to do with what this case measures.
        subject: `hello ${i}`, body: `hello ${i}`,
        to: [{ name: null, address: "nora@partner.test" }], status: "draft",
      }).returning();
      await svc.send(ctx, d!.id, `learn-${randomUUID()}`, {
        openSendAdapter: appendingAdapter(), resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
      });
    }
    expect((await contactRows(accountId)).map((r) => r.address)).toEqual(["nora@partner.test"]);
  });

  it("learning does NOT depend on the Sent projection — an adapter that appends silently still teaches", async () => {
    const { accountId, draftId, ctx } = await seeded(["quiet@partner.test"]);

    // No `appended`, so `projectSentCopy` returns before it does anything. This is the whole
    // reason the write sits in `finalizeSent` instead.
    const res = await svc.send(ctx, draftId, `learn-${randomUUID()}`, {
      openSendAdapter: silentAdapter(), resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
    });
    expect(res.status).toBe("sent");
    expect((await known(accountId)).has("quiet@partner.test")).toBe(true);
  });

  it("an account erased while the mail was in flight learns nothing — and the send still finalizes", async () => {
    const { accountId, draftId, ctx } = await seeded(["late@partner.test"]);
    await db.insert(accounts).values({ id: accountId, name: `erased-${accountId.slice(0, 8)}` });

    const res = await svc.send(ctx, draftId, `learn-${randomUUID()}`, {
      openSendAdapter: erasingAdapter(accountId), resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
    });
    // The mail was delivered: the finalize must not be refused for an erasure it cannot undo.
    expect(res.status).toBe("sent");
    // And nothing was written back into the account the sweep just emptied.
    expect(await contactRows(accountId), "a contact resurrected into an erased account").toEqual([]);
  });

  it("CONTROL — an address nobody wrote to stays a stranger", async () => {
    const { accountId, draftId, ctx } = await seeded(["nora@partner.test"]);
    await svc.send(ctx, draftId, `learn-${randomUUID()}`, {
      openSendAdapter: appendingAdapter(), resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
    });
    const set = await known(accountId);
    expect(set.has("someone-else@elsewhere.test")).toBe(false);
    // And the account's own address is not invented as a contact by this write — the consent seed
    // owns that row, and two writers of one fact is how they drift.
    expect([...set].length).toBe(1);
  });
});
