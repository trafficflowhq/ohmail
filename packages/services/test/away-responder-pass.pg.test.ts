import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import {
  accounts, awayReplies, awayResponders, awaySenderState, folderState, mailboxes, messageBodies,
  messages,
} from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import type { OutboundMessage, SendAdapter } from "@trafficflow/core";
import { runAwayResponderPass } from "../src/away-responder-pass.js";

/**
 * THE AWAY RESPONDER'S RESERVATION AND THROTTLE, ON REAL POSTGRES, UNDER TWO CONNECTIONS.
 *
 * ── WHY PGlite GREEN IS WORTH NOTHING FOR THIS FILE'S SUBJECT ────────────────────────────────
 *
 * PGlite is ONE connection. Every assertion about "two runners race and exactly one wins" is
 * vacuous there: the two calls are serialised by the driver's own mutex before they ever reach a
 * lock, so an implementation with NO reservation at all — a plain read-then-write — passes the
 * PGlite suite completely. That is this repository's standing rule ("PGlite green means nothing
 * for transactional code"), and this feature is exactly its shape: the whole safety argument for
 * the responder is that a correspondent cannot be answered twice.
 *
 * So the two things that CANNOT be tested anywhere else are tested here, each with two real
 * clients contending on one row:
 *
 *   1. THE RESERVATION — `INSERT … ON CONFLICT (account_id, message_id) DO NOTHING RETURNING id`.
 *      Two passes over the same message deliver ONE reply.
 *   2. THE THROTTLE — `INSERT … ON CONFLICT (account_id, sender) DO UPDATE … WHERE <predicate>`.
 *      Two passes over two DIFFERENT messages from the same sender, inside one `per_day` window,
 *      deliver ONE reply. This is the one a read-then-write cannot get right: both runners read
 *      "not answered recently", both decide to send, and the correspondent gets two.
 *
 * ── SCOPED TO ITS OWN MAILBOX, AND THE FIRST RUN PROVED WHY ─────────────────────────────────
 *
 * This runs against the SHARED test Postgres, and the pass is STORE-WIDE by design — on the hosted
 * host one invocation serves the whole fleet, so `liveResponders` has no account filter at all.
 * Unscoped, the two runners here therefore answered every OTHER live responder the shared database
 * happened to be carrying, and each spent its entire `AWAY_SENDS_PER_RUN`: the first run of this
 * file reported `expected 10 to be 1` — two runners times a budget of five, not a broken
 * reservation.
 *
 * So every invocation passes `mailboxIds: [s.mailboxId]`, which is a real production shape (the
 * sidecar's drain passes exactly that, once per runtime) and not a test-only affordance. Each
 * assertion then reads only the account it seeded.
 *
 * That first failure is worth keeping in the header rather than deleting with the fix, because it
 * is also the clearest available demonstration of why the global send budget needs an ordering:
 * two runners with nothing to arbitrate between accounts will both spend everything on whatever
 * the scan happens to return first.
 */
const PG_UP = await realPgAvailable();

const NOW = new Date("2026-09-02T12:00:00.000Z");
const ENABLED_AT = new Date("2026-09-02T11:00:00.000Z");

/** TWO clients, so the two passes below are genuinely two connections. */
let clientA: ReturnType<typeof postgres>;
let clientB: ReturnType<typeof postgres>;
let dbA: ReturnType<typeof drizzle>;
let dbB: ReturnType<typeof drizzle>;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  clientA = postgres(PG_TEST_URL, { max: 4 });
  clientB = postgres(PG_TEST_URL, { max: 4 });
  dbA = brandDialect(drizzle(clientA), "pg");
  dbB = brandDialect(drizzle(clientB), "pg");
});

afterAll(async () => {
  await clientA?.end({ timeout: 5 });
  await clientB?.end({ timeout: 5 });
});

/**
 * A LOG SPY, and it exists because of a mutation that stayed GREEN.
 *
 * Removing `onConflictDoNothing` from the reservation left every assertion below passing: the
 * loser's INSERT raises a unique violation, `reserve`'s transaction aborts, and the per-account
 * try/catch in `runAwayResponderPass` swallows it and moves on — so the run still delivered exactly
 * one reply and the tests could not tell a working reservation from a raising one.
 *
 * They are not the same thing. A clean stop leaves the loser free to go on and answer the REST of
 * that account's candidates; a raised 23505 abandons the whole account for that run. The difference
 * is only visible in what was logged, so that is what is asserted.
 */
function logSpy() {
  const errors: string[] = [];
  const warns: string[] = [];
  const log = {
    info: () => {},
    warn: (event: string) => { warns.push(event); },
    error: (event: string) => { errors.push(event); },
    child: () => log,
  } as unknown as Parameters<typeof runAwayResponderPass>[1]["log"];
  return { log, errors, warns };
}

/** Counts what each runner actually handed to a transport. */
function recorder() {
  const delivered: OutboundMessage[] = [];
  const factory = async (): Promise<SendAdapter> => ({
    send: async (m: OutboundMessage) => {
      // A real dial takes time, which is what opens the window a read-then-write would fall
      // through. Without it both passes can finish their claim before either reaches a send.
      await new Promise((r) => setTimeout(r, 15));
      delivered.push(m);
      return { providerMessageId: `<p-${delivered.length}>` };
    },
    messageInSent: async () => false,
    close: async () => {},
  }) as unknown as SendAdapter;
  return { factory, delivered };
}

interface Seeded { accountId: string; mailboxId: string }

async function seed(throttle: "always" | "per_message" | "per_day" | "per_week"): Promise<Seeded> {
  const accountId = randomUUID();
  // No `users` row: the pass never reads one, and a fixture that seeds tables its subject does not
  // touch is a fixture that breaks when THOSE tables change. `accounts` is here only because
  // `mailboxes.account_id` references it.
  await dbA.insert(accounts).values({ id: accountId, name: "away pg" });
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId}@away.test`,
    organizerRole: "organizer", status: "connected",
  }).returning();
  await dbA.insert(awayResponders).values({
    accountId, enabled: true, body: "Back Monday.", audience: "screened_in",
    throttle, enabledAt: ENABLED_AT, updatedAt: ENABLED_AT,
  });
  return { accountId, mailboxId: mb!.id };
}

async function arrive(s: Seeded, from: string, subject: string): Promise<string> {
  const at = new Date(NOW.getTime() - 60_000);
  const [m] = await dbA.insert(messages).values({
    accountId: s.accountId, mailboxId: s.mailboxId,
    messageIdHeader: `<${randomUUID()}@them.test>`,
    bodyHash: randomUUID(), dedupKey: randomUUID(),
    subject, fromAddress: from, date: at, createdAt: at,
  }).returning();
  await dbA.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "hello", headers: {} });
  await dbA.insert(folderState).values({
    /* INBOX — the Ohbox pile's real folder. "ohmail/Ohbox" is a string no product source
       writes, so this row was a placement the router cannot produce (mail 0096). */
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
  });
  return m!.id;
}

const ledgerRows = async (s: Seeded) =>
  dbA.select().from(awayReplies).where(eq(awayReplies.accountId, s.accountId));

describe.skipIf(!PG_UP)("the reservation, under two real connections", () => {
  /**
   * THE UNIQUE IS THE GUARD. Both runners see the same candidate, both attempt the ledger INSERT,
   * exactly one gets a row back and the other stops without sending.
   *
   * Mutation to watch red: drop `.onConflictDoNothing(...)` from the reservation and this raises a
   * unique-violation instead of delivering once — which is the honest failure, and still a failure.
   * Replace the whole reservation with a read-then-write and TWO replies leave.
   */
  it("two passes over ONE message deliver exactly one reply, and the loser stops CLEANLY", async () => {
    const s = await seed("always");
    await arrive(s, "colleague@them.test", "the roof");
    const a = recorder();
    const b = recorder();
    const spyA = logSpy();
    const spyB = logSpy();

    const [ra, rb] = await Promise.all([
      runAwayResponderPass(dbA as never, {
        openSendAdapter: a.factory, now: () => NOW, mailboxIds: [s.mailboxId], log: spyA.log,
      }),
      runAwayResponderPass(dbB as never, {
        openSendAdapter: b.factory, now: () => NOW, mailboxIds: [s.mailboxId], log: spyB.log,
      }),
    ]);

    expect(a.delivered.length + b.delivered.length).toBe(1);
    expect(ra.sent + rb.sent).toBe(1);

    const rows = await ledgerRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("sent");

    /* THE HALF A COUNT CANNOT SEE. `ON CONFLICT DO NOTHING` makes the loser return zero rows and
       stop; WITHOUT it the loser raises 23505, `reserve`'s transaction aborts, and the per-account
       catch swallows it — one reply either way, but in the second case that runner abandoned the
       whole account. Watched red: delete the `onConflictDoNothing` and this line fails with
       `away_responder_account_failed`. */
    expect([...spyA.errors, ...spyB.errors]).toEqual([]);
  });

  it("the loser records nothing at all — no second ledger row, no second sender-state row", async () => {
    const s = await seed("always");
    await arrive(s, "colleague@them.test", "the roof");
    const a = recorder();
    const b = recorder();

    await Promise.all([
      runAwayResponderPass(dbA as never, {
        openSendAdapter: a.factory, now: () => NOW, mailboxIds: [s.mailboxId],
      }),
      runAwayResponderPass(dbB as never, {
        openSendAdapter: b.factory, now: () => NOW, mailboxIds: [s.mailboxId],
      }),
    ]);

    expect(await ledgerRows(s)).toHaveLength(1);
    const state = await dbA.select().from(awaySenderState)
      .where(eq(awaySenderState.accountId, s.accountId));
    expect(state).toHaveLength(1);
  });
});

describe.skipIf(!PG_UP)("the throttle, under two real connections", () => {
  /**
   * THE CASE A READ-THEN-WRITE CANNOT GET RIGHT, and the reason the throttle is an upsert.
   *
   * Two DIFFERENT messages from ONE sender, claimed by two runners at the same instant, inside one
   * `per_day` window. Each reservation succeeds — they are different messages, so the UNIQUE does
   * not arbitrate — and the ONLY thing standing between the correspondent and two identical
   * auto-replies is the `ON CONFLICT … DO UPDATE … WHERE` on `away_sender_state`.
   *
   * Mutation watched red: delete `setWhere` from the upsert and both replies leave.
   */
  it("two passes over TWO messages from one sender deliver exactly one reply", async () => {
    const s = await seed("per_day");
    await arrive(s, "colleague@them.test", "one");
    await arrive(s, "colleague@them.test", "two");
    const a = recorder();
    const b = recorder();

    const [ra, rb] = await Promise.all([
      runAwayResponderPass(dbA as never, {
        openSendAdapter: a.factory, now: () => NOW, mailboxIds: [s.mailboxId],
      }),
      runAwayResponderPass(dbB as never, {
        openSendAdapter: b.factory, now: () => NOW, mailboxIds: [s.mailboxId],
      }),
    ]);

    expect(a.delivered.length + b.delivered.length).toBe(1);
    expect(ra.sent + rb.sent).toBe(1);
    // Both messages are DECIDED — one sent, one throttled — so neither stays a candidate.
    const rows = await ledgerRows(s);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.outcome === "sent")).toHaveLength(1);
    expect(rows.filter((r) => r.outcome === "throttled")).toHaveLength(1);
    expect(ra.throttled + rb.throttled).toBe(1);
  });

  it("`always` under the same contention answers BOTH — the throttle is what differs, not the race", async () => {
    const s = await seed("always");
    await arrive(s, "colleague@them.test", "one");
    await arrive(s, "colleague@them.test", "two");
    const a = recorder();
    const b = recorder();

    await Promise.all([
      runAwayResponderPass(dbA as never, {
        openSendAdapter: a.factory, now: () => NOW, mailboxIds: [s.mailboxId],
      }),
      runAwayResponderPass(dbB as never, {
        openSendAdapter: b.factory, now: () => NOW, mailboxIds: [s.mailboxId],
      }),
    ]);

    // Two messages, two reservations, a predicate that admits every time: two replies, and that is
    // correct. This is the control for the case above — it proves the single delivery there came
    // from the THROTTLE and not from the two runners simply never overlapping.
    expect(a.delivered.length + b.delivered.length).toBe(2);
  });

  /**
   * `per_message` — "once, until you change the text" — under contention. The predicate compares a
   * stored hash to the responder's CURRENT text, so two runners holding the same text must produce
   * one reply however they interleave.
   */
  it("`per_message` under contention answers once for one text", async () => {
    const s = await seed("per_message");
    await arrive(s, "colleague@them.test", "one");
    await arrive(s, "colleague@them.test", "two");
    const a = recorder();
    const b = recorder();

    await Promise.all([
      runAwayResponderPass(dbA as never, {
        openSendAdapter: a.factory, now: () => NOW, mailboxIds: [s.mailboxId],
      }),
      runAwayResponderPass(dbB as never, {
        openSendAdapter: b.factory, now: () => NOW, mailboxIds: [s.mailboxId],
      }),
    ]);

    expect(a.delivered.length + b.delivered.length).toBe(1);

    // Change the TEXT and a later run answers again — the state row was advanced, not merely set.
    await dbA.update(awayResponders).set({ body: "Back Tuesday." })
      .where(eq(awayResponders.accountId, s.accountId));
    await arrive(s, "colleague@them.test", "three");
    const c = recorder();
    await runAwayResponderPass(dbA as never, {
      openSendAdapter: c.factory, now: () => new Date(NOW.getTime() + 1000),
      mailboxIds: [s.mailboxId],
    });
    expect(c.delivered).toHaveLength(1);
  });
});

describe.skipIf(!PG_UP)("the finalize is a compare-and-swap", () => {
  /**
   * A late finalizer must not overwrite a terminal row. Without `AND outcome = 'pending'` a second
   * writer turns `sent` into `unverified` — the same defect the interactive send path's finalizers
   * were found to have, and the same fix.
   */
  it("a terminal row is not moved by a second finalize", async () => {
    const s = await seed("always");
    const id = await arrive(s, "colleague@them.test", "the roof");
    const a = recorder();
    await runAwayResponderPass(dbA as never, {
      openSendAdapter: a.factory, now: () => NOW, mailboxIds: [s.mailboxId],
    });

    const before = (await ledgerRows(s))[0]!;
    expect(before.outcome).toBe("sent");

    // Replay exactly what the pass's own finalize issues, as a late writer would.
    await dbB.update(awayReplies)
      .set({ outcome: "unverified", reason: "Error" })
      .where(and(
        eq(awayReplies.accountId, s.accountId),
        eq(awayReplies.messageId, id),
        eq(awayReplies.outcome, "pending"),
      ));

    const after = (await ledgerRows(s))[0]!;
    expect(after.outcome).toBe("sent");
    expect(after.sentAt).not.toBeNull();
  });
});

describe.skipIf(!PG_UP)("migration 0087 landed the shape the pass depends on", () => {
  it("the reservation index and the throttle primary key both exist", async () => {
    const idx = await clientA`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'away_replies' AND indexname = 'away_replies_message_uq'`;
    expect(idx).toHaveLength(1);

    const pk = await clientA`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'away_sender_state'::regclass AND contype = 'p'`;
    expect(pk).toHaveLength(1);
  });

  it("the outcome and throttle CHECKs refuse a member nobody enumerated", async () => {
    const s = await seed("per_day");
    await expect(
      clientA`INSERT INTO away_replies (account_id, mailbox_id, message_id, sender, outcome)
              VALUES (${s.accountId}::uuid, ${s.mailboxId}::uuid, ${randomUUID()}::uuid, 'x@y.test', 'invented')`,
    ).rejects.toThrow();
    await expect(
      clientA`UPDATE away_responders SET throttle = 'hourly' WHERE account_id = ${s.accountId}::uuid`,
    ).rejects.toThrow();
  });
});
