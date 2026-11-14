import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import { accounts, awayReplies, folderState, mailboxes, messages } from "@trafficflow/db";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "../../../apps/worker/test/_isolateddb.js";
import { materializeMessages } from "../src/dto/materialize.js";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * ═══ THE AWAY-ANSWER STAMP'S LEDGER READ, ON REAL POSTGRES ════════════════════════════════
 *
 * ── WHY PGlite GREEN IS NOT ENOUGH FOR THIS READ ────────────────────────────────────────────
 *
 * The twin (`dto-away-replied-at.test.ts`) proves the truth table; this file proves the QUERY
 * that produces it survives a real driver, and that is a different question. Two measured
 * divergences in this repository are exactly this shape and neither was visible to PGlite:
 *
 *   · a JS `Date` interpolated into a raw `sql` fragment has no column to take its type from, so
 *     `postgres@3` refused what PGlite converted;
 *   · a bare JS array interpolated into a raw `sql` template is FLATTENED by drizzle, so a
 *     one-element `any(${ids}::uuid[])` rendered a scalar and a zero-element one a syntax error —
 *     again accepted by PGlite.
 *
 * This read carries a `timestamptz` on the way OUT (`sent_at` → `Date` → ISO) and two multi-value
 * predicates on the way IN (the id set and the outcome set). It is written with `inArray` and
 * `isNotNull` rather than a fragment for precisely that reason, and this file is what makes that
 * a measurement rather than a preference.
 *
 * ── A PRIVATE DATABASE, NOT THE SHARED `trafficflow_test` ───────────────────────────────────
 *
 * `prepareIsolatedDb` — the recreate policy, and one database this file owns. The shared box's
 * migration watermark belongs to the release chain, and a filler lane recording its own journal
 * there blocks every lower `when` for everybody; a page read of `away_replies` needs nothing that
 * the shared accumulator's thousands of mailbox rows would add, and a `sent_at` another run stamped in
 * the future is exactly the co-tenancy that has produced product-looking reds here before.
 */
const DB_NAME = "trafficflow_away_mark_dto";
const SENT_AT = new Date("2026-09-09T08:15:00.000Z");
const READS = "ohmail/News";

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
/** The private database's URL, as `prepareIsolatedDb` handed it back — never reconstructed. */
let dbUrl: string;
let accountId: string;
let mailboxId: string;

beforeAll(async () => {
  dbUrl = await prepareIsolatedDb(DB_NAME);
  client = postgres(dbUrl, { max: 2 });
  db = brandDialect(drizzle(client), "pg");
}, ISOLATED_DB_RESET_BUDGET_MS);

afterAll(async () => {
  await client?.end({ timeout: 5 });
});

/**
 * Each case starts from an empty database and seeds its own account. The truncate is this file's
 * own — nothing else uses `DB_NAME` — and it is what keeps one case's ledger row out of the next
 * case's page read, which is the failure mode a shared table produces.
 */
beforeEach(async () => {
  await truncateAll(dbUrl);
  accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "away mark dto" });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId}@away.test`,
    organizerRole: "organizer", status: "connected",
  }).returning();
  mailboxId = mb!.id;
}, ISOLATED_DB_RESET_BUDGET_MS);

async function seed(opts: { from?: string; folder?: string } = {}): Promise<string> {
  const { from = "news@sender.test", folder = READS } = opts;
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "the roundup", fromAddress: from, date: new Date("2026-09-09T07:00:00.000Z"),
    nativeLocator: { folder, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    snippet: "hi", unread: false,
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

async function ledger(
  messageId: string,
  outcome: "sent" | "unverified" | "pending" | "throttled" | "suppressed",
  sentAt: Date | null,
): Promise<void> {
  await db.insert(awayReplies).values({
    accountId, mailboxId, messageId, sender: "news@sender.test", outcome, sentAt,
  });
}

describe("MessageDTO.awayRepliedAt against real Postgres", () => {
  it("carries the `timestamptz` out as the exact ISO instant the ledger holds", async () => {
    const id = await seed();
    await ledger(id, "sent", SENT_AT);
    const dto = (await materializeMessages(db as never, accountId, [id])).get(id);
    expect(dto?.awayRepliedAt).toBe(SENT_AT.toISOString());
    // The database's own reading of the same column, so the assertion above is about the
    // projection rather than about what the fixture happened to insert.
    const [row] = await db.select({ sentAt: awayReplies.sentAt }).from(awayReplies)
      .where(eq(awayReplies.messageId, id));
    expect(row!.sentAt!.toISOString()).toBe(SENT_AT.toISOString());
  });

  /**
   * THE OUTCOME SET AND THE ID SET IN ONE PAGE, WITH BOTH MEMBERS OF EACH REACHED.
   *
   * Five messages, five outcomes, one call. This is the case a flattened multi-value predicate
   * cannot pass: `inArray(outcome, ["sent","unverified"])` has to admit BOTH members and refuse
   * the other three, over an id list longer than one — the two shapes that have diverged between
   * PGlite and `postgres@3` here.
   */
  it("admits both outcome members and refuses the other three, over a five-id page", async () => {
    const sent = await seed();
    const unverifiedWith = await seed();
    const unverifiedWithout = await seed();
    const throttled = await seed();
    const suppressed = await seed();
    await ledger(sent, "sent", SENT_AT);
    await ledger(unverifiedWith, "unverified", SENT_AT);
    await ledger(unverifiedWithout, "unverified", null);
    await ledger(throttled, "throttled", null);
    await ledger(suppressed, "suppressed", null);

    const dtos = await materializeMessages(db as never, accountId,
      [sent, unverifiedWith, unverifiedWithout, throttled, suppressed]);
    expect(dtos.size).toBe(5);
    expect(dtos.get(sent)?.awayRepliedAt).toBe(SENT_AT.toISOString());
    expect(dtos.get(unverifiedWith)?.awayRepliedAt).toBe(SENT_AT.toISOString());
    expect(dtos.get(unverifiedWithout)?.awayRepliedAt).toBeNull();
    expect(dtos.get(throttled)?.awayRepliedAt).toBeNull();
    expect(dtos.get(suppressed)?.awayRepliedAt).toBeNull();
  });

  /** A ONE-id page — the size at which a flattened array predicate renders a scalar and throws. */
  it("reads a single-id page without a malformed predicate", async () => {
    const id = await seed();
    await ledger(id, "sent", SENT_AT);
    expect((await materializeMessages(db as never, accountId, [id])).get(id)?.awayRepliedAt)
      .toBe(SENT_AT.toISOString());
  });

  it("is NULL for a message with no ledger row, on a page of one and a page of three", async () => {
    const bare = await seed();
    const other = await seed();
    const answered = await seed();
    await ledger(answered, "sent", SENT_AT);
    expect((await materializeMessages(db as never, accountId, [bare])).get(bare)?.awayRepliedAt)
      .toBeNull();
    const three = await materializeMessages(db as never, accountId, [bare, other, answered]);
    expect(three.get(bare)?.awayRepliedAt).toBeNull();
    expect(three.get(other)?.awayRepliedAt).toBeNull();
    expect(three.get(answered)?.awayRepliedAt).toBe(SENT_AT.toISOString());
  });

  /**
   * ANOTHER ACCOUNT'S LEDGER ROW FOR OUR MESSAGE ID — AND WHICH LAYER REFUSES IT. This docblock
   * used to argue the row was storable because `away_replies` had no foreign key to `messages`;
   * mail 0118 retired that premise with `(message_id, account_id)` → `messages (id, account_id)`
   * `ON DELETE SET NULL ("message_id")` — the record still outlives the message it answers, but a
   * foreign account can no longer point at ours. So the KEY is asserted first, and the
   * `account_id` PREDICATE is then driven against a row planted with that one key lifted, which
   * is what keeps dropping the predicate from the read a red here rather than a pass.
   */
  it("refuses another account's ledger row for our message id, and reads none planted past the key", async () => {
    const id = await seed();
    const stranger = randomUUID();
    await db.insert(accounts).values({ id: stranger, name: "stranger" });
    const [smb] = await db.insert(mailboxes).values({
      accountId: stranger, provider: "imap", address: `s-${stranger}@away.test`,
    }).returning();
    const row = {
      accountId: stranger, mailboxId: smb!.id, messageId: id,
      sender: "news@sender.test", outcome: "sent", sentAt: SENT_AT,
    };
    const verdict = await db.insert(awayReplies).values(row).then(
      () => "admitted",
      (e: unknown) => (/away_replies_message_id_account_fk/.test(String(e))
        ? "refused-by-the-key" : `refused-otherwise:${String(e)}`),
    );
    expect(verdict, "the cross-account ledger row is representable again").toBe("refused-by-the-key");

    /* The predicate's own arm. This file owns its database, so the key comes off, the row goes in,
       and both go back before the next case — the schema this case met is the schema it leaves. */
    await db.execute(sql`alter table away_replies
      drop constraint away_replies_message_id_account_fk`);
    try {
      await db.insert(awayReplies).values(row);
      expect((await materializeMessages(db as never, accountId, [id])).get(id)?.awayRepliedAt)
        .toBeNull();
    } finally {
      await db.delete(awayReplies).where(eq(awayReplies.accountId, stranger));
      await db.execute(sql`alter table away_replies
        add constraint away_replies_message_id_account_fk
        foreign key ("message_id", "account_id") references messages ("id", "account_id")
        on delete set null ("message_id")`);
    }
  });
});
