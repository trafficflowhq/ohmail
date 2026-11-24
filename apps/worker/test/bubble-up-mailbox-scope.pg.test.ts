import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, asc, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, changeLog, mailboxes, messages, messageStates, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { bubbleUpPass } from "@ohmail/organizer/bubble-up";
import { loadEnabledMailboxes, organizedMailboxIdsOf } from "../src/mailboxes.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE RESURFACING PASS FLIPS ONLY THE MAILBOXES ITS CALLER ORGANIZES
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The organizer lease is per MAILBOX and this pass was scoped by ACCOUNT alone, so an install
 * holding two mailboxes of one account — organizing one, standing down on the other — flipped
 * both. Mail came back on a device in parallel with the real organizer of the mailbox it had
 * handed over, which is the one thing the lease exists to prevent.
 *
 * The fixture is that install: mailbox A `organizer_role = 'organizer'`, mailbox B `'reader'`,
 * one past-due `bubbled_up` booking in each, both under one account. The roles are the SITUATION
 * and not the filter — the pass takes the set its caller passes and reads no role — so the last
 * case drives the hosts' own derivation over these very rows and asserts it yields {A}.
 *
 * REAL POSTGRES on this worktree's lane database, never the shared box: the flip is a
 * transaction that allocates a change-log seq, and `inArray` over a join is bound by postgres-js
 * rather than PGlite (`sync-stamp.pg.test.ts` is the precedent — a fragment PGlite bound happily
 * and the driver did not).
 */
const AVAILABLE = await realPgAvailable();

const PAST = new Date("2026-09-01T08:00:00.000Z");
const NOW = new Date("2026-09-18T09:00:00.000Z");

describe.skipIf(!AVAILABLE)("bubbleUpPass — the mailbox scope", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    db = brandDialect(drizzle(postgres(PG_TEST_URL, { max: 4, onnotice: () => {} }), { schema }), "pg");
  }, 60_000);

  interface Seeded {
    accountId: string;
    a: { mailboxId: string; messageId: string; stateId: string };
    b: { mailboxId: string; messageId: string; stateId: string };
  }

  /** One account, two mailboxes, one due booking in each — the install the defect was reported on. */
  const seed = async (): Promise<Seeded> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `scope-${accountId.slice(0, 8)}` });
    const mailbox = async (role: "organizer" | "reader"): Promise<string> => {
      const [mb] = await db.insert(mailboxes).values({
        accountId, provider: "imap", status: "connected", organizerRole: role,
        address: `scope-${randomUUID()}@example.test`,
      }).returning();
      return mb!.id;
    };
    const booking = async (mailboxId: string): Promise<{ messageId: string; stateId: string }> => {
      const dedup = `mid:${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
        subject: "until Friday at nine", fromAddress: "a@example.test",
        nativeLocator: { folder: "INBOX", ref: "1:1" },
      }).returning();
      const [st] = await db.insert(messageStates).values({
        accountId, messageId: m!.id, state: "bubbled_up", bubbleUpAt: PAST,
      }).returning();
      return { messageId: m!.id, stateId: st!.id };
    };
    const aMailbox = await mailbox("organizer");
    const bMailbox = await mailbox("reader");
    return {
      accountId,
      a: { mailboxId: aMailbox, ...(await booking(aMailbox)) },
      b: { mailboxId: bMailbox, ...(await booking(bMailbox)) },
    };
  };

  /** The whole state row as text — the comparison is "nothing about it moved", not "the state did not". */
  const rowText = async (stateId: string): Promise<string> => {
    const [row] = await db.select().from(messageStates).where(eq(messageStates.id, stateId));
    return JSON.stringify(row, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v));
  };

  const changesOf = async (accountId: string) =>
    db.select().from(changeLog).where(eq(changeLog.accountId, accountId)).orderBy(asc(changeLog.seq));

  it("flips the organized mailbox's due row and leaves the handed-over one byte-identical", async () => {
    const s = await seed();
    const bBefore = await rowText(s.b.stateId);

    const res = await bubbleUpPass(db as unknown as Tx, NOW, {
      accountId: s.accountId, mailboxIds: [s.a.mailboxId],
    });
    expect(res.flipped).toBe(1);

    const [a] = await db.select().from(messageStates).where(eq(messageStates.id, s.a.stateId));
    expect(a!.state).toBe("resurfaced");
    expect(a!.bubbleUpAt).toBeNull();
    expect(a!.setAt?.toISOString()).toBe(NOW.toISOString());

    // B is the claim. Not "still bubbled_up" — nothing about the row moved, `updatedAt` included,
    // because a pass that touched it and put it back is still a pass that ran in somebody else's
    // mailbox.
    expect(await rowText(s.b.stateId),
      "a mailbox this caller does not organize was written by the resurfacing pass").toBe(bBefore);

    // EXACTLY THE PAIR, AND BOTH NAME A: the state row and the message that projects it. A change
    // naming B would reach every live client of that mailbox and pin a row nobody resurfaced.
    const changes = await changesOf(s.accountId);
    expect(changes.map((c) => [c.entityType, c.entityId])).toEqual([
      ["message_state", s.a.stateId], ["message", s.a.messageId],
    ]);
  }, 30_000);

  it("flips both when the caller organizes both — the scope, not a pass that stopped working", async () => {
    const s = await seed();
    const res = await bubbleUpPass(db as unknown as Tx, NOW, {
      accountId: s.accountId, mailboxIds: [s.a.mailboxId, s.b.mailboxId],
    });
    expect(res.flipped).toBe(2);
    for (const id of [s.a.stateId, s.b.stateId]) {
      const [row] = await db.select().from(messageStates).where(eq(messageStates.id, id));
      expect(row!.state).toBe("resurfaced");
    }
  }, 30_000);

  it("refuses a call with no mailbox set, names why, and writes nothing", async () => {
    const s = await seed();
    const aBefore = await rowText(s.a.stateId);
    const bBefore = await rowText(s.b.stateId);

    /* THE CAST IS THE POINT. The signature asks for the set, so this is the shape a JavaScript
       caller or a host added later arrives in — and the answer it must get is nothing, never the
       account-wide flip this pass used to do by default. */
    const res = await bubbleUpPass(db as unknown as Tx, NOW, { accountId: s.accountId } as never);
    expect(res.flipped).toBe(0);
    expect(res.refused ?? "").toMatch(/mailbox scope/);

    expect(await rowText(s.a.stateId)).toBe(aBefore);
    expect(await rowText(s.b.stateId)).toBe(bBefore);
    expect(await changesOf(s.accountId)).toHaveLength(0);
  }, 30_000);

  it("takes an EMPTY set as no mailbox rather than every mailbox", async () => {
    const s = await seed();
    const res = await bubbleUpPass(db as unknown as Tx, NOW, {
      accountId: s.accountId, mailboxIds: [],
    });
    expect(res.flipped).toBe(0);
    /* And it is not the refusal wearing a different hat: an empty set is a stood-down install
       saying so, which the caller may log differently from a caller that passed nothing at all.
       The rendering is the installed drizzle's, read rather than assumed —
       `drizzle-orm@0.36.4/sql/expressions/conditions.js:73-77`: `inArray(col, [])` returns
       `sql\`false\``, so the arm selects nothing instead of being dropped. */
    expect(res.refused).toBeUndefined();
    expect(await changesOf(s.accountId)).toHaveLength(0);
  }, 30_000);

  it("is the set the hosts derive: the roster rows of this fixture yield the organizing mailbox alone", async () => {
    const s = await seed();
    const roster = await loadEnabledMailboxes(db as never);
    expect(organizedMailboxIdsOf(roster, s.accountId)).toEqual([s.a.mailboxId]);
  }, 30_000);
});
