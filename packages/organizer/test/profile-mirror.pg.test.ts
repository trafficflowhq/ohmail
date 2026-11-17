import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, mailboxProfileMirror } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { applyProfileRead } from "../src/profile.js";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE MIRROR ROW UNDER CONCURRENCY — real Postgres, two live connections
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `mailbox_profile_mirror` is keyed by `mailbox_id` ALONE: one row per mailbox, by design. Two
 * reader passes for one mailbox can therefore contend on the same row, and the property that has to
 * hold is not "one of them wins" — it is that the surviving row's `(uidvalidity, uid)` is one of
 * the pairs a read actually produced, never a MIXTURE of two.
 *
 * A mixed row is the whole defect this table's shape exists to prevent: a generation from one epoch
 * beside a uid from another addresses whatever now holds that small integer, and it would be served
 * as the current settings document by `GET /mailboxes/:id/profile` with nothing failing.
 *
 * None of this is expressible on PGlite: it is single-connection, so two awaited calls there are
 * sequential by construction and a sequential test of a concurrent property cannot fail.
 */
const PG_UP = await realPgAvailable();

const sqlA = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const sqlB = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
const dbA = brandDialect(drizzle(sqlA, { schema }), "pg");
const dbB = brandDialect(drizzle(sqlB, { schema }), "pg");

const NOW = new Date("2026-09-07T12:00:00.000Z");
const noop = () => { /* the outcomes are asserted, not the log */ };

const DOC = (tag: string) => ({
  v: 1, updatedAt: "2026-09-07T10:00:00.000Z",
  producer: { kind: "cloud", version: tag },
  screener: [], rules: [], notifyRules: [], tagNames: [],
  awayResponder: null, signature: `— ${tag}`,
});

async function world(): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  await dbA.insert(accounts).values({ id: accountId, name: `pmpg-${accountId.slice(0, 8)}` });
  const [mb] = await dbA.insert(mailboxes).values({
    accountId, provider: "imap", address: `pmpg-${accountId.slice(0, 8)}@mirror.test`,
    organizerRole: "reader", organizerState: "held",
    organizedByKind: "cloud", organizedByName: "ohmail Cloud",
  }).returning();
  return { accountId, mailboxId: mb!.id };
}

/** The two consistent pairs a read can produce here — a surviving row must be one of them. */
const PAIRS: ReadonlyArray<{ generation: number; uid: number }> = [
  { generation: 1757000000, uid: 42 },
  { generation: 1757000001, uid: 7 },
];

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await sqlA.end({ timeout: 5 }); await sqlB.end({ timeout: 5 }); });

describe.skipIf(!PG_UP)("two reader passes writing one mailbox's mirror", () => {
  it("leaves ONE row, and its pair is one a read produced — never a mixture", async () => {
    const w = await world();

    // Two passes at DIFFERENT generations, started together on two live connections so their
    // writes interleave. Different uids too, so a mixed row is visible rather than coincidental.
    const [a, b] = await Promise.all([
      applyProfileRead(
        { db: dbA as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log: noop },
        {
          state: "found", doc: DOC("A") as never, installId: "cloud-A",
          ref: PAIRS[0]!.uid, generation: PAIRS[0]!.generation, residue: 0,
        },
      ),
      applyProfileRead(
        { db: dbB as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log: noop },
        {
          state: "found", doc: DOC("B") as never, installId: "cloud-B",
          ref: PAIRS[1]!.uid, generation: PAIRS[1]!.generation, residue: 0,
        },
      ),
    ]);
    expect(a).toMatchObject({ state: "written" });
    expect(b).toMatchObject({ state: "written" });

    const rows = await dbA.select().from(mailboxProfileMirror)
      .where(eq(mailboxProfileMirror.mailboxId, w.mailboxId));
    // ONE row: the primary key is the mailbox, and two mirrors of one mailbox is not a state this
    // feature has.
    expect(rows).toHaveLength(1);

    const got = { generation: Number(rows[0]!.uidvalidity), uid: rows[0]!.uid };
    // …and it is one of the two pairs, WHOLE. This is the assertion that would fail on a partial
    // update: `{1757000000, 7}` and `{1757000001, 42}` are both reachable if the columns can move
    // independently, and neither describes anything that was ever read.
    expect(PAIRS).toEqual(expect.arrayContaining([got]));
    // The document belongs to the same pass as the pair — a row carrying one pass's locator and
    // the other's document would be the same lie in a different column.
    const expectedTag = got.uid === PAIRS[0]!.uid ? "A" : "B";
    expect((rows[0]!.doc as { producer: { version: string } }).producer.version).toBe(expectedTag);
    expect(rows[0]!.accountId).toBe(w.accountId);
  });

  it("a DISCARD racing a WRITE leaves either no row or a whole one, never a husk", async () => {
    /* The renumber sequence, run as a race: one pass finds a document at a new generation while
     * another finds the folder empty and discards. Both are correct answers about different
     * moments, and either outcome is fine — what must not exist afterwards is a row that is
     * present but incoherent. */
    const w = await world();
    await dbA.insert(mailboxProfileMirror).values({
      mailboxId: w.mailboxId, accountId: w.accountId,
      uidvalidity: 999n, uid: 3, doc: DOC("old") as unknown as object,
      readAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    await Promise.all([
      applyProfileRead(
        { db: dbA as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log: noop },
        {
          state: "found", doc: DOC("A") as never, installId: "cloud-A",
          ref: PAIRS[0]!.uid, generation: PAIRS[0]!.generation, residue: 0,
        },
      ),
      applyProfileRead(
        { db: dbB as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log: noop },
        { state: "none" },
      ),
    ]);

    const rows = await dbA.select().from(mailboxProfileMirror)
      .where(eq(mailboxProfileMirror.mailboxId, w.mailboxId));
    expect(rows.length).toBeLessThanOrEqual(1);
    if (rows.length === 1) {
      // Whole, and not the pre-existing husk: whichever pass wrote last wrote all of it.
      const got = { generation: Number(rows[0]!.uidvalidity), uid: rows[0]!.uid };
      expect(PAIRS).toEqual(expect.arrayContaining([got]));
      expect(rows[0]!.uidvalidity).not.toBe(999n);
    }
  });

  it("a mirror row whose account disagrees with its mailbox is REFUSED, on both paths", async () => {
    /* The row is keyed by mailbox alone, so a conflict path that left `account_id` behind could
     * leave a row whose account disagrees with the mailbox's owner — which the read side then
     * (correctly) refuses to serve, and the mailbox's own mirror goes quiet. Mail 0116 keyed
     * `(mailbox_id, account_id)` to `mailboxes (id, account_id)`, so neither path can write it:
     * the insert is asked here, and so is the UPDATE, because a key that only bit on insert would
     * leave exactly the conflict path this case was written about. */
    const w = await world();
    const stranger = randomUUID();
    await dbA.insert(accounts).values({ id: stranger, name: `str-${stranger.slice(0, 8)}` });

    const code = async (run: () => Promise<unknown>): Promise<string | null> => {
      try { await run(); return null; } catch (err) {
        return String((err as { code?: unknown }).code ?? "unknown");
      }
    };

    expect(await code(() => dbA.insert(mailboxProfileMirror).values({
      mailboxId: w.mailboxId, accountId: stranger,
      uidvalidity: 1n, uid: 1, doc: DOC("stale") as unknown as object, readAt: NOW,
    }))).toBe("23503");

    // The ordinary write lands, and then the same row cannot be moved to another account either.
    await applyProfileRead(
      { db: dbA as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log: noop },
      {
        state: "found", doc: DOC("A") as never, installId: "cloud-A",
        ref: PAIRS[0]!.uid, generation: PAIRS[0]!.generation, residue: 0,
      },
    );
    const [r] = await dbA.select().from(mailboxProfileMirror)
      .where(eq(mailboxProfileMirror.mailboxId, w.mailboxId));
    expect(r!.accountId).toBe(w.accountId);

    expect(await code(() => dbA.update(mailboxProfileMirror)
      .set({ accountId: stranger })
      .where(eq(mailboxProfileMirror.mailboxId, w.mailboxId)))).toBe("23503");
  });
});
