import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import {
  accounts, awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies,
  messages,
} from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OutboundMessage, SendAdapter } from "@trafficflow/core";
import { runAwayResponderPass } from "../src/away-responder-pass.js";

/**
 * A RELEASE RE-PROJECTS THE SENDER'S THROTTLE FROM THE LEDGER, and that holds with a SIBLING
 * reservation on the same person standing beside it — which a snapshot of the state before the
 * reservation does not: a sibling's upsert overwrites the row, and the snapshot then puts back a
 * value nobody sent, or deletes one a sent reply justified. Two passes on two connections, one per
 * mailbox of one account (the sidecar's shape), paused at the send boundary so both reservations
 * stand. Real Postgres on the lane database: PGlite is one connection and orders nothing.
 */
const PG_UP = await realPgAvailable();

const TA = new Date("2026-09-02T12:00:00.000Z");
const TB = new Date("2026-09-02T12:00:05.000Z");
const ENABLED_AT = new Date("2026-09-02T11:00:00.000Z");
const THEM = "colleague@them.test";

let clientA: ReturnType<typeof postgres>;
let clientB: ReturnType<typeof postgres>;
let dbA: ReturnType<typeof drizzle>;
let dbB: ReturnType<typeof drizzle>;
const seeded: string[] = [];

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  clientA = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  clientB = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
  dbA = brandDialect(drizzle(clientA), "pg");
  dbB = brandDialect(drizzle(clientB), "pg");
});

afterEach(async () => {
  if (!PG_UP || seeded.length === 0) return;
  const ids = seeded.splice(0);
  const mine = dbA.select({ id: messages.id }).from(messages).where(inArray(messages.accountId, ids));
  await dbA.delete(awayReplies).where(inArray(awayReplies.accountId, ids));
  await dbA.delete(awaySenderState).where(inArray(awaySenderState.accountId, ids));
  await dbA.delete(folderState).where(inArray(folderState.messageId, mine));
  await dbA.delete(messageBodies).where(inArray(messageBodies.messageId, mine));
  await dbA.delete(messages).where(inArray(messages.accountId, ids));
  await dbA.delete(awayResponders).where(inArray(awayResponders.accountId, ids));
  await dbA.delete(mailboxes).where(inArray(mailboxes.accountId, ids));
  await dbA.delete(accounts).where(inArray(accounts.id, ids));
});

afterAll(async () => {
  await clientA?.end({ timeout: 5 });
  await clientB?.end({ timeout: 5 });
});

interface World { accountId: string; x: string; y: string }

/** One account, two organizing mailboxes, one message from THEM in each. */
async function world(throttle: "always" | "per_day"): Promise<World> {
  const accountId = randomUUID();
  seeded.push(accountId);
  await dbA.insert(accounts).values({ id: accountId, name: "away release pg" });
  const box = async (n: string) => (await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `${n}-${accountId}@away.test`,
    organizerRole: "organizer", status: "connected",
  }).returning())[0]!.id;
  const x = await box("x");
  const y = await box("y");
  await dbA.insert(awayResponders).values({
    accountId, enabled: true, body: "Back Monday.", audience: "everyone",
    throttle, piles: ["INBOX"], enabledAt: ENABLED_AT, updatedAt: ENABLED_AT,
  });
  for (const mailboxId of [x, y]) {
    const at = new Date(TA.getTime() - 60_000);
    const [m] = await dbA.insert(messages).values({
      accountId, mailboxId, messageIdHeader: `<${randomUUID()}@them.test>`,
      bodyHash: randomUUID(), dedupKey: randomUUID(), subject: "the roof",
      fromAddress: THEM, date: at, createdAt: at,
    }).returning();
    await dbA.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "hello", headers: {} });
    await dbA.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    });
  }
  return { accountId, x, y };
}

function transport() {
  const delivered: OutboundMessage[] = [];
  const factory = async (): Promise<SendAdapter> => ({
    send: async (m: OutboundMessage) => { delivered.push(m); return { providerMessageId: "<p>" }; },
    messageInSent: async () => false,
    close: async () => {},
  }) as unknown as SendAdapter;
  return { factory, delivered };
}

const stateOf = async (w: World) =>
  (await dbA.select().from(awaySenderState).where(eq(awaySenderState.accountId, w.accountId)))
    .map((s) => s.lastRepliedAt.toISOString());
const outcomes = async (w: World) =>
  (await dbA.select().from(awayReplies).where(eq(awayReplies.accountId, w.accountId)))
    .map((r) => `${r.mailboxId === w.x ? "A" : "B"}:${r.outcome}`).sort();

/** A latch: one side opens it, the other waits on it. */
function latch() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}

/**
 * Two passes, A on mailbox X at `TA` and B on mailbox Y at `TB`. Each is asked the lease before its
 * reservation (yes) and at the dial, where `atDial` decides. B reaches its dial only after A has
 * reserved, so both reservations stand when the first answer is given.
 */
async function interleave(w: World, atDial: {
  a: (ctx: { bReserved: Promise<void>; bDone: () => Promise<unknown> }) => Promise<boolean>;
  b: (ctx: { aDone: Promise<unknown> }) => Promise<boolean>;
}) {
  const aReserved = latch();
  const bReserved = latch();
  const asks = { a: 0, b: 0 };
  const ta = transport();
  const tb = transport();
  const held: { passB?: Promise<unknown> } = {};
  const passA = runAwayResponderPass(dbA as never, {
    openSendAdapter: ta.factory, now: () => TA, mailboxIds: [w.x],
    stillOrganizing: async () => {
      if (++asks.a === 1) return true;
      aReserved.open();
      return atDial.a({ bReserved: bReserved.opened, bDone: () => held.passB! });
    },
  });
  const passB = held.passB = (async () => {
    await aReserved.opened;
    return runAwayResponderPass(dbB as never, {
      openSendAdapter: tb.factory, now: () => TB, mailboxIds: [w.y],
      stillOrganizing: async () => {
        if (++asks.b === 1) return true;
        bReserved.open();
        return atDial.b({ aDone: passA });
      },
    });
  })();
  const [ra, rb] = await Promise.all([passA, passB]);
  return { ra, rb, sentA: ta.delivered.length, sentB: tb.delivered.length };
}

describe.skipIf(!PG_UP)("a release beside a sibling reservation on the same person", () => {
  it("A sent, B released: the state is A's reply", async () => {
    const w = await world("always");
    const r = await interleave(w, {
      a: async ({ bReserved }) => { await bReserved; return true; },
      b: async ({ aDone }) => { await aDone; return false; },
    });
    expect([r.sentA, r.sentB]).toEqual([1, 0]);
    expect(await outcomes(w)).toEqual(["A:sent"]);
    expect(await stateOf(w), "the release put back a value nobody sent").toEqual([TA.toISOString()]);
  });

  it("both released: the sender row is gone", async () => {
    const w = await world("always");
    const r = await interleave(w, {
      a: async ({ bReserved }) => { await bReserved; return false; },
      b: async ({ aDone }) => { await aDone; return false; },
    });
    expect([r.sentA, r.sentB]).toEqual([0, 0]);
    expect(await outcomes(w)).toEqual([]);
    expect(await stateOf(w), "a released pair left the person throttled").toEqual([]);
  });

  it("A released while B is still pending: the state is B's", async () => {
    const w = await world("always");
    let between: string[] = [];
    await interleave(w, {
      a: async ({ bReserved }) => { await bReserved; return false; },
      b: async ({ aDone }) => { await aDone; between = await stateOf(w); return true; },
    });
    expect(between, "A's release dropped B's standing reservation").toEqual([TB.toISOString()]);
    expect(await outcomes(w)).toEqual(["B:sent"]);
    expect(await stateOf(w)).toEqual([TB.toISOString()]);
  });

  it("B-THEN-A CONTROL — B released while A is still pending: the state is A's", async () => {
    const w = await world("always");
    let between: string[] = [];
    await interleave(w, {
      a: async ({ bReserved, bDone }) => {
        await bReserved;
        await bDone();
        between = await stateOf(w);
        return true;
      },
      b: async () => false,
    });
    expect(between, "B's release dropped A's standing reservation").toEqual([TA.toISOString()]);
    expect(await outcomes(w)).toEqual(["A:sent"]);
    expect(await stateOf(w)).toEqual([TA.toISOString()]);
  });

  it("per_day twin: B is throttled, nothing is released, and A's reply is the state", async () => {
    const w = await world("per_day");
    const r = await interleave(w, {
      a: async () => true,
      b: async () => { throw new Error("a throttled candidate must never reach the dial"); },
    });
    expect([r.sentA, r.sentB]).toEqual([1, 0]);
    expect(r.rb.throttled).toBe(1);
    expect(await outcomes(w)).toEqual(["A:sent", "B:throttled"]);
    expect(await stateOf(w)).toEqual([TA.toISOString()]);
  });
});
