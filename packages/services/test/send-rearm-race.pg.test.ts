import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { drafts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendService, ServiceError } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * A RE-ARM AND A FRESH PRESS OF THE SAME WORDS, AT ONCE, SEND ONE MESSAGE. Real Postgres, three
 * connections: the key's replay re-arms its failed row while a second draft carrying the identical
 * message is pressed under a new key, and a third connection holds the account's change counter so
 * both transactions stand open past their decisive reads. The fresh press reads the claim's row
 * status before it re-points the claim; were the re-arm's own read of the claim unlocked, that press
 * would read `failed` under the uncommitted re-arm and both would send.
 */
const PG_UP = await realPgAvailable();

const conn = (name: string) => postgres(PG_TEST_URL, { max: 4, onnotice: () => {}, connection: { application_name: name } });
const sqlA = conn("rearm-race-a");
const sqlB = conn("rearm-race-b");
const sqlC = conn("rearm-race-hold");
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-10-19T09:00:00.000Z");
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

/** Until a backend of this connection waits on a lock — the transaction standing open where it should. */
async function waitingOnALock(name: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const rows = await sqlC`select 1 from pg_stat_activity where application_name = ${name} and wait_event_type = 'Lock'`;
    if (rows.length > 0) return;
    await sleep(10);
  }
  throw new Error(`${name} never waited on a lock`);
}

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await Promise.all([sqlA, sqlB, sqlC].map((s) => s.end({ timeout: 5 }))); });

describe.skipIf(!PG_UP)("a re-arm racing a fresh press of the same words", () => {
  it("one message leaves: the fresh press is refused as a duplicate of the re-armed send", async () => {
    const accountId = randomUUID();
    const [mb] = await dbA.insert(mailboxes).values({
      accountId, provider: "imap", address: `rearm-${accountId.slice(0, 8)}@race.test`,
    }).returning();
    const twin = async (): Promise<string> => {
      const [d] = await dbA.insert(drafts).values({
        accountId, mailboxId: mb!.id, subject: "The list", body: "See below.",
        to: [{ name: null, address: "you@race.test" }], status: "draft", createdAt: NOW, updatedAt: NOW,
      }).returning();
      return d!.id;
    };
    const [first, second] = [await twin(), await twin()];
    const delivered: OutboundMessage[] = [];
    let dials = 0;
    const open: OpenSendAdapter = async () => {
      dials += 1;
      if (dials === 1) throw Object.assign(new Error("closed"), { code: "EIMAPCLOSED" });
      return {
        async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId! }; },
        async messageInSent() { return false; },
        async close() { /* nothing */ },
      };
    };
    const ctx = (db: typeof dbA, id: string): ServiceContext => ({ db, accountId, userId: null, now: () => NOW, requestId: id });
    const svc = new SendService();
    const failed = await svc.send(ctx(dbA, "a0"), first, "k1", { openSendAdapter: open, rearmTransient: true }).catch((e: unknown) => e);
    expect((failed as ServiceError).retryable).toBe(true);

    // The account's change counter, held: every writer below stops at its draft change, after its reads.
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const holding = sqlC.begin(async (tx) => {
      await tx`select next_seq from account_sync_state where account_id = ${accountId} for update`;
      await released;
    });
    await sleep(50);
    const replay = svc.send(ctx(dbA, "a1"), first, "k1", { openSendAdapter: open, rearmTransient: true });
    await waitingOnALock("rearm-race-a");
    const fresh = svc.send(ctx(dbB, "b1"), second, "k2", { openSendAdapter: open, rearmTransient: true });
    await waitingOnALock("rearm-race-b");
    release();
    await holding;
    const [r1, r2] = await Promise.allSettled([replay, fresh]);
    const said = (r: PromiseSettledResult<{ status: string }>): string => r.status === "fulfilled"
      ? r.value.status : r.reason instanceof ServiceError ? r.reason.code : `threw ${String(r.reason)}`;
    expect({ replay: said(r1), fresh: said(r2), delivered: delivered.length })
      .toEqual({ replay: "sent", fresh: "duplicate_send", delivered: 1 });
  }, 60_000);
});
