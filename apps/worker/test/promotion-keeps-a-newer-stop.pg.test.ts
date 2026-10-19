import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  clearOrganizerStandDown, markMailboxStoodDown, type OneShotsAsRead,
} from "../src/mailboxes.js";

/**
 * ═══ A ONE-SHOT IS SPENT BY THE EVENT THAT CAUSED IT, NEVER BY ONE PASSING THROUGH ═════════
 *
 * The promotion used to write `release_requested_at = NULL` unconditionally. Its comment stated
 * the intent correctly — a promotion must not inherit a stop asked of the role this row used to
 * hold — and the form could not keep it: an unconditional clear cannot tell an OLD ask from a NEW
 * one. Stop, Resume, Stop again while Resume's IMAP gate is still running; the promotion lands
 * after that third press and erases the accepted Stop. Leave anytime IS the product, and the
 * mailbox then organizes for ever.
 *
 * REAL POSTGRES, because this is a row-ordering property: the arms turn on one statement's
 * predicate being evaluated against a value another writer committed while the decision was in
 * flight, which is what PGlite says nothing about.
 */

const AVAILABLE = await realPgAvailable();

/** The decision's start, the press during it, and the write — three distinct instants. */
const READ_AT = new Date("2026-09-14T09:00:00.000Z");
const PRESSED_DURING = new Date("2026-09-14T09:00:30.000Z");
const WROTE_AT = new Date("2026-09-14T09:01:00.000Z");
/** An ask the decision HELD IN ITS HAND when it started — the stale one. */
const ASKED_BEFORE = new Date("2026-09-14T08:59:00.000Z");

describe.skipIf(!AVAILABLE)("a role change spends only the one-shots it read", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  const seed = async (values: {
    organizerRole: "organizer" | "reader";
    releaseRequestedAt?: Date | null;
    takeoverAuthorizedAt?: Date | null;
  }): Promise<string> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `oneshot-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `oneshot-${accountId.slice(0, 8)}@example.test`,
      ...values,
    }).returning();
    return mb!.id;
  };

  const rowOf = async (id: string): Promise<{
    organizerRole: string; releaseRequestedAt: Date | null; takeoverAuthorizedAt: Date | null;
  }> => {
    const [r] = await db.select({
      organizerRole: mailboxes.organizerRole,
      releaseRequestedAt: mailboxes.releaseRequestedAt,
      takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
    }).from(mailboxes).where(eq(mailboxes.id, id));
    return r!;
  };

  /** The person's press, landing while the gate is out on the network. */
  const pressStopDuringTheGate = async (id: string): Promise<void> => {
    await db.update(mailboxes)
      .set({ releaseRequestedAt: PRESSED_DURING })
      .where(eq(mailboxes.id, id));
  };

  // ── ARM 1 · THE DEFECT ─────────────────────────────────────────────────────────────────────

  it("a PROMOTION keeps a Stop pressed after it started, and the mailbox stops", async () => {
    /* Stop, then Resume — `organizeHere` writes the authorization and clears the ask in ONE
       statement, so the gate begins on a row with a stamp and no ask. */
    const id = await seed({ organizerRole: "reader", takeoverAuthorizedAt: READ_AT });
    const asRead: OneShotsAsRead = await rowOf(id);

    // …and the third press lands while the gate is still talking to the mail server.
    await pressStopDuringTheGate(id);

    const promoted = await clearOrganizerStandDown(db as never, id, { now: WROTE_AT, asRead });
    expect(promoted, "the promotion did not write").toBe(true);

    const r = await rowOf(id);
    expect(r.organizerRole, "the role flip must still land — the claim is already in the folder")
      .toBe("organizer");
    expect(
      r.releaseRequestedAt?.toISOString(),
      "the promotion erased a Stop pressed after it started; the mailbox organizes for ever",
    ).toBe(PRESSED_DURING.toISOString());
  });

  // ── ARM 2 · THE POSITIVE CONTROL THE UNCONDITIONAL CLEAR EXISTS FOR ────────────────────────

  it("a PROMOTION still clears a STALE stop — the ask the decision read at its start", async () => {
    /* The defect the clear was written to close: an ask made of the role this row used to hold.
       If this arm ever reddens, the fix above re-opened it. */
    const id = await seed({ organizerRole: "reader", releaseRequestedAt: ASKED_BEFORE });
    const asRead: OneShotsAsRead = await rowOf(id);
    expect(asRead.releaseRequestedAt?.toISOString(), "the fixture's own ask is missing")
      .toBe(ASKED_BEFORE.toISOString());

    const promoted = await clearOrganizerStandDown(db as never, id, { now: WROTE_AT, asRead });
    expect(promoted).toBe(true);

    const r = await rowOf(id);
    expect(r.organizerRole).toBe("organizer");
    expect(r.releaseRequestedAt, "the promotion inherited a previous role's ask").toBeNull();
  });

  // ── ARM 3 · THE SAME PAIR AGAINST THE DEMOTION, WHICH SHARES THE RULE ──────────────────────

  it("a DEMOTION keeps a Stop pressed after it started", async () => {
    const id = await seed({ organizerRole: "organizer" });
    const asRead: OneShotsAsRead = await rowOf(id);
    await pressStopDuringTheGate(id);

    const written = await markMailboxStoodDown(db as never, id, "organized_elsewhere:local", {
      now: WROTE_AT, asRead,
      by: { installId: "laptop-7", kind: "local", displayName: "kitchen mac", state: "held" },
    });
    expect(written, "the demotion did not write").toBe(true);

    const r = await rowOf(id);
    expect(r.organizerRole).toBe("reader");
    expect(
      r.releaseRequestedAt?.toISOString(),
      "the demotion erased a Stop pressed after it started",
    ).toBe(PRESSED_DURING.toISOString());
  });

  it("a DEMOTION still clears the stale stop it read — a reader carries no ask it cannot perform",
    async () => {
      const id = await seed({ organizerRole: "organizer", releaseRequestedAt: ASKED_BEFORE });
      const asRead: OneShotsAsRead = await rowOf(id);

      const written = await markMailboxStoodDown(db as never, id, "organized_elsewhere:local", {
        now: WROTE_AT, asRead,
        by: { installId: "laptop-7", kind: "local", displayName: "kitchen mac", state: "held" },
      });
      expect(written).toBe(true);

      const r = await rowOf(id);
      expect(r.organizerRole).toBe("reader");
      expect(r.releaseRequestedAt,
        "the loser's stop request stands on a row that now names the winner").toBeNull();
    });

  // ── THE SIBLING ONE-SHOT, CLASSIFIED UNDER THE SAME RULE ───────────────────────────────────

  it("a DEMOTION keeps an 'Organize here' pressed after it started", async () => {
    /* The same defect wearing the other column's name: the press asks for a becoming this
       demotion never weighed, and clearing it would spend a press on its own refusal. */
    const id = await seed({ organizerRole: "organizer" });
    const asRead: OneShotsAsRead = await rowOf(id);
    await db.update(mailboxes)
      .set({ takeoverAuthorizedAt: PRESSED_DURING }).where(eq(mailboxes.id, id));

    await markMailboxStoodDown(db as never, id, "organized_elsewhere:local", {
      now: WROTE_AT, asRead,
      by: { installId: "laptop-7", kind: "local", displayName: "kitchen mac", state: "held" },
    });

    const r = await rowOf(id);
    expect(
      r.takeoverAuthorizedAt?.toISOString(),
      "the demotion spent an authorization it never read",
    ).toBe(PRESSED_DURING.toISOString());
  });

  it("a PROMOTION still spends the authorization that BOUGHT it — the positive control",
    async () => {
      // §4, "No seize-back": left standing, a lapse-then-resubscribe months later would seize the
      // mailbox back from whatever a human deliberately moved it to.
      const id = await seed({ organizerRole: "reader", takeoverAuthorizedAt: READ_AT });
      const asRead: OneShotsAsRead = await rowOf(id);

      await clearOrganizerStandDown(db as never, id, { now: WROTE_AT, asRead });

      const r = await rowOf(id);
      expect(r.organizerRole).toBe("organizer");
      expect(r.takeoverAuthorizedAt, "the press stayed spendable after the becoming it bought")
        .toBeNull();
    });

  // ── AND THE READING THE CALLER NAMED IS THE ONE THAT DECIDES ───────────────────────────────

  it("a decision that read NO ask spends none — anything standing arrived after it", async () => {
    /* The discriminator between "clears what it read" and "clears whatever is there": the row
       carries an ask at the write, and the decision began without one. */
    const id = await seed({ organizerRole: "reader" });
    const asRead: OneShotsAsRead = await rowOf(id);
    expect(asRead.releaseRequestedAt).toBeNull();
    await pressStopDuringTheGate(id);

    await clearOrganizerStandDown(db as never, id, { now: WROTE_AT, asRead });

    expect((await rowOf(id)).releaseRequestedAt?.toISOString(),
      "a null reading was treated as permission to clear").toBe(PRESSED_DURING.toISOString());
  });
});

/**
 * ═══ A STAMP THE DATABASE CLOCK WROTE IS SPENT ON ITS FIRST ROLE CHANGE ═══════════════════════
 *
 * Postgres keeps microseconds; the reading arrives as a JavaScript `Date`, which keeps
 * milliseconds. `stamp <= asRead` was false for any stamp with digits past its millisecond, so a
 * stamp `now()` wrote was never spent: every visit promoted again, rang the arrangement and restarted
 * the retro jobs. The comparison is at the reading's precision; a press from the next millisecond
 * on is still newer than the reading and survives.
 */
describe.skipIf(!AVAILABLE)("a one-shot the database clock wrote", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  type Col = "takeover_authorized_at" | "release_requested_at";

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  const seed = async (organizerRole: "organizer" | "reader"): Promise<string> => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `oneshot-us-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `oneshot-us-${accountId.slice(0, 8)}@example.test`, organizerRole,
    }).returning();
    return mb!.id;
  };

  /** 407 µs past a millisecond: under 500, so red whether the parser truncates or rounds. */
  const plant = async (id: string, col: Col): Promise<void> => {
    await sql`update mailboxes set ${sql(col)} = date_trunc('milliseconds', now()) + interval '407 microseconds'
      where id = ${id}`;
    expect(await textOf(id, col), "the plant carries no microseconds").toMatch(/\.\d{3}407\b/);
  };

  const textOf = async (id: string, col: Col): Promise<string | null> =>
    (await sql<Array<{ t: string | null }>>`select ${sql(col)}::text as t from mailboxes where id = ${id}`)[0]!.t;

  const read = async (id: string): Promise<OneShotsAsRead> => {
    const [r] = await db.select({
      releaseRequestedAt: mailboxes.releaseRequestedAt, takeoverAuthorizedAt: mailboxes.takeoverAuthorizedAt,
    }).from(mailboxes).where(eq(mailboxes.id, id));
    return r!;
  };

  const by = { installId: "laptop-7", kind: "local" as const, displayName: "kitchen mac", state: "held" as const };

  it("a PROMOTION spends a takeover stamp it read", async () => {
    const id = await seed("reader");
    await plant(id, "takeover_authorized_at");
    expect(await clearOrganizerStandDown(db as never, id, { now: WROTE_AT, asRead: await read(id) })).toBe(true);
    expect(await textOf(id, "takeover_authorized_at"), "the press the promotion read is still standing")
      .toBeNull();
  });

  it("a PROMOTION spends a release stamp it read", async () => {
    const id = await seed("reader");
    await plant(id, "release_requested_at");
    expect(await clearOrganizerStandDown(db as never, id, { now: WROTE_AT, asRead: await read(id) })).toBe(true);
    expect(await textOf(id, "release_requested_at"), "the stop the promotion read is still standing").toBeNull();
  });

  it("a DEMOTION spends both stamps it read", async () => {
    const id = await seed("organizer");
    await plant(id, "takeover_authorized_at");
    await plant(id, "release_requested_at");
    expect(await markMailboxStoodDown(db as never, id, "organized_elsewhere:local", {
      now: WROTE_AT, asRead: await read(id), by,
    })).toBe(true);
    expect(await textOf(id, "takeover_authorized_at"), "the demotion left the press it read").toBeNull();
    expect(await textOf(id, "release_requested_at"), "the demotion left the stop it read").toBeNull();
  });

  it("CONTROL: a Stop written as a Date 1 ms after the read survives the promotion", async () => {
    const id = await seed("reader");
    await plant(id, "release_requested_at");
    const asRead = await read(id);
    await db.update(mailboxes)
      .set({ releaseRequestedAt: new Date(asRead.releaseRequestedAt!.getTime() + 1) })
      .where(eq(mailboxes.id, id));
    await clearOrganizerStandDown(db as never, id, { now: WROTE_AT, asRead });
    expect(await textOf(id, "release_requested_at"), "a newer Stop was spent by an older read").not.toBeNull();
  });

  it("CONTROL: a press the database wrote at read + 1001 µs survives the demotion", async () => {
    const id = await seed("organizer");
    await plant(id, "takeover_authorized_at");
    const asRead = await read(id);
    await sql`update mailboxes set takeover_authorized_at =
      ${asRead.takeoverAuthorizedAt!.toISOString()}::timestamptz + interval '1001 microseconds' where id = ${id}`;
    await markMailboxStoodDown(db as never, id, "organized_elsewhere:local", { now: WROTE_AT, asRead, by });
    expect(await textOf(id, "takeover_authorized_at"), "a press from the next millisecond was spent")
      .not.toBeNull();
  });
});
