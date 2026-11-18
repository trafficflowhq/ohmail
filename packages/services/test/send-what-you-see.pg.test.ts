import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { mailboxes, drafts } from "@trafficflow/db";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendService, dbFor, materializeDraft } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * THE OTHER WINDOW'S WRITE UNDER A REAL ROW LOCK — the interleaving PGlite cannot run.
 *
 * The defect is a race: the second window's autosave commits between this press's final save and
 * its send. The check that closes it reads the draft `FOR UPDATE` inside the reserve transaction,
 * so what it must be watched doing is reading what the OTHER writer committed while it waited —
 * not a value the same connection wrote a moment earlier. PGlite is one connection and nothing
 * can hold a lock against anything, so the ordering this file asserts is unreachable there.
 *
 * The second case is the one a timestamp revision would get wrong and this one does not: the
 * other window writes an IDENTICAL buffer back. The row moved, the message did not, and refusing
 * there would be a false alarm about a draft nobody changed.
 */
const PG_UP = await realPgAvailable();

// The factory's handle: the binder takes a server handle only from the factory that registered its
// door. `sqlB` is the other window's raw client.
const owned = makeOwnedDb(PG_TEST_URL);
const dbA = owned.db;
const sqlB = postgres(PG_TEST_URL, { max: 10, onnotice: () => {} });

const NOW = new Date("2026-09-14T12:00:00.000Z");
const sendSvc = new SendService();
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

/** A fake SendAdapter — no network. Keeps every envelope it was asked to deliver. */
function fakeAdapter() {
  const state = { delivered: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.delivered.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to tear down */ },
  });
  return { factory, state };
}

async function seeded() {
  const accountId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `author-${tag}@trafficflow.test`,
  }).returning();
  const [d] = await dbA.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "the invoice",
    body: "Here is the invoice you asked for.",
    to: [{ name: null, address: "chosen@example.com" }], status: "draft",
    createdAt: NOW, updatedAt: NOW,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(dbA, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  // READ THE WAY A CLIENT READS IT — off the row's own DTO, never recomputed here.
  const dto = await materializeDraft(dbA, accountId, d!.id);
  return { ctx, draftId: d!.id, revision: dto!.contentRevision };
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await owned.close(); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("a send that waited on another window's write", () => {
  it("reads what the other window committed and refuses — nothing is delivered", async () => {
    const w = await seeded();
    const fake = fakeAdapter();

    // Connection B is the other window's autosave. It writes and HOLDS the row lock.
    let releaseLock!: () => void;
    const held = new Promise<void>((r) => { releaseLock = r; });
    const otherWindow = sqlB.begin(async (tx) => {
      await tx`update drafts set body = 'scratch notes — do not send',
                                 "to" = ${sqlB.json([{ name: null, address: "someone-else@example.com" }])}
               where id = ${w.draftId}`;
      await held;
    });
    await sleep(150); // let the write take its row lock

    // Connection A presses Send, vouching for the row it last saw. Reserve must WAIT.
    const sendP = sendSvc.send(
      w.ctx, w.draftId, randomUUID(),
      { openSendAdapter: fake.factory },
      { ifContentRevision: w.revision },
    ).then(() => null).catch((e: unknown) => e as { code?: string; httpStatus?: number });
    await sleep(300);
    expect(fake.state.delivered, "the send read past the other window's uncommitted write").toHaveLength(0);

    releaseLock();
    await otherWindow;
    const refusal = await sendP;

    expect(
      fake.state.delivered.map((m) => m.text),
      "the other window's words were delivered under this press",
    ).toEqual([]);
    expect(refusal, "a row that moved under the press was sent anyway").not.toBeNull();
    expect(refusal!.code).toBe("draft_changed");
    expect(refusal!.httpStatus).toBe(409);

    const [row] = await dbA.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(row!.status, "a refused send left the row unsendable").toBe("draft");
  });

  it("sends when the other window wrote the SAME message back — the row moved, the message did not", async () => {
    const w = await seeded();
    const fake = fakeAdapter();

    // The identical buffer, written back. `updated_at` moves; nothing the author can see does.
    await sqlB`update drafts set updated_at = now() where id = ${w.draftId}`;

    const res = await sendSvc.send(
      w.ctx, w.draftId, randomUUID(),
      { openSendAdapter: fake.factory },
      { ifContentRevision: w.revision },
    );

    expect(res.status).toBe("sent");
    expect(fake.state.delivered).toHaveLength(1);
    expect(fake.state.delivered[0]!.text).toContain("Here is the invoice you asked for.");
  });
});
