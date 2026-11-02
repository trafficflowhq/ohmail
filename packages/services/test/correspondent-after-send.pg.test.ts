import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect, carryDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { accounts, contacts, drafts, mailboxFolders, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  UNMETERED_STORAGE_CAP, commitChange, planChange,
  type Change, type OpenSendAdapter, type OutboundMessage,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { SendService, type ServiceContext } from "../src/index.js";

/**
 * THE MEASUREMENT THE DISPATCHER ASKED FOR (FIX-023): is a reply to a message sent THROUGH OHMAIL
 * held? The send teaches `contacts` at finalize, so the person written to is known — this file
 * says so on real Postgres, from the send door to the gate. The second arm is the reported shape
 * that door cannot see: the answer comes from ANOTHER address of theirs, naming our message in
 * In-Reply-To — admitted by the correspondent's reply arm, held before it. Addresses `.invalid`.
 */
const PG_UP = await realPgAvailable();
const sql = postgres(PG_TEST_URL, { max: 6, onnotice: () => {} });
const db = brandDialect(drizzle(sql, { schema }), "pg");
const svc = new SendService();

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sql.end({ timeout: 5 }); });

/** SMTP, then an APPEND it can report — the Sent copy the send projects into the mirror. */
function appendingAdapter(): OpenSendAdapter {
  return async () => ({
    async send(msg: OutboundMessage) {
      const raw = Buffer.from([
        `Message-ID: ${msg.messageId!}`, "From: me@own.invalid",
        `To: ${[msg.to ?? []].flat().map((a) => (typeof a === "string" ? a : a.address)).join(", ")}`, "Subject: the north elevation", "", "Thursday?", "",
      ].join("\r\n"));
      return {
        providerMessageId: msg.messageId!,
        appended: { locator: { folder: "Sent", ref: `7:${Math.floor(Math.random() * 1e6)}` }, raw },
      };
    },
    async messageInSent() { return true; },
    async close() { /* nothing to tear down */ },
  });
}

async function sentTo(address: string): Promise<{ accountId: string; mailboxId: string; minted: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `after-send-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid`, status: "connected",
  }).returning();
  // A mailbox the sync has already walked has its Sent folder on record.
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: "Sent", uidvalidity: 7n, uidnext: 1n });
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the north elevation", body: "Thursday?",
    to: [{ name: null, address }], status: "draft",
  }).returning();
  const ctx: ServiceContext = {
    db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => new Date(), requestId: "r",
  };
  let minted = "";
  const res = await svc.send(ctx, d!.id, `after-send-${randomUUID()}`, {
    openSendAdapter: async (...a) => {
      const inner = await appendingAdapter()(...a);
      return { ...inner, async send(msg: OutboundMessage) { minted = msg.messageId!; return inner.send(msg); } };
    },
    resolveStorageCap: async () => UNMETERED_STORAGE_CAP,
  });
  expect(res.status).toBe("sent");
  return { accountId, mailboxId: mb!.id, minted: minted.replace(/^<|>$/g, "") };
}

async function arrives(w: { accountId: string; mailboxId: string }, from: string, inReplyTo?: string): Promise<string> {
  const raw = Buffer.from([
    `Message-ID: <reply-${randomUUID()}@corr.invalid>`, `From: ${from}`, "To: me@own.invalid",
    "Subject: Re: the north elevation", ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}>`] : []),
    "Content-Type: text/plain; charset=utf-8", "", "Thursday works.", "",
  ].join("\r\n"));
  const change: Change = { type: "create", locator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` }, raw, internalDate: new Date() };
  const plan = await planChange(change, { ...w, repo: makeDrizzleRepo(db as never), readerMode: false });
  await db.transaction(async (tx) => commitChange(plan, {
    ...w, repo: makeDrizzleRepo(carryDialect(db, tx) as never), storageCap: UNMETERED_STORAGE_CAP,
  }));
  return plan.new!.desired;
}

describe.skipIf(!PG_UP)("a reply to mail this account sent through ohmail", () => {
  it("MEASUREMENT: the person written to answers from the address written to — not held", async () => {
    const w = await sentTo("them@corr.invalid");
    expect(await arrives(w, "them@corr.invalid")).toBe("INBOX");
  });

  it("the reported shape: they answer from another address, naming our message — not held", async () => {
    const w = await sentTo("them@corr.invalid");
    expect(w.minted).not.toBe("");
    expect(await arrives(w, "them@elsewhere.invalid", w.minted)).toBe("INBOX");
  });

  it("the other address is not remembered: the answer arrives and teaches no contact", async () => {
    const w = await sentTo("them@corr.invalid");
    expect(await arrives(w, "them@elsewhere.invalid", w.minted)).toBe("INBOX");
    const taught = await db.select({ a: contacts.address }).from(contacts)
      .where(and(eq(contacts.accountId, w.accountId), eq(contacts.address, "them@elsewhere.invalid")));
    expect(taught, "no person and no inferred row from that admission").toEqual([]);
  });

  it("CONTROL: a stranger naming nothing we sent is held", async () => {
    const w = await sentTo("them@corr.invalid");
    expect(await arrives(w, "someone@stranger.invalid", "not-ours@own.invalid")).toBe("ohmail/Screener");
  });
});
